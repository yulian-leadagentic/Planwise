/**
 * QA6 P4 (PR-063): the pure rules of the Workload drag-and-drop: drag
 * rights, the drop check (service gate, project Team, department
 * approval), the before→after preview, the tray's "Causing overload"
 * group, the request body, the optimistic update and the toast text.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOptimisticMove,
  applyPeopleRows,
  applyTaskPatch,
  applyTrayMove,
  approveToastText,
  canDragChip,
  departmentKey,
  dropCheck,
  dropReasonText,
  mergeAssignProjects,
  nextWorkingDays,
  overloadCausing,
  previewPct,
  providesService,
  reassignBody,
  reassignErrorKey,
  reassignErrorText,
  reassignToastText,
  trayLandingDays,
  workingDayDelta,
  workingDaysBetween,
} from './workload-assign';
import {
  EMPTY_ASSIGN,
  isPersonalTask,
  normalizeDecisionResponse,
  normalizeReassignResponse,
  normalizeTaskEntry,
  normalizeTeamWorkload,
  normalizeTray,
  type WorkloadAssign,
  type WorkloadTaskEntry,
  type WorkloadTray,
} from './workload-contract';
import type { TeamWorkload, TeamWorkloadPerson } from './workload-range';

const DAYS = ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'];
const REST = [5, 6]; // Fri + Sat

function task(over: Partial<WorkloadTaskEntry> = {}): WorkloadTaskEntry {
  return {
    id: 4021,
    code: 'CRD-040',
    name: 'דוח תיאום קריטי',
    projectId: 59,
    projectName: 'ניסוי 9',
    service: { id: 7, name: 'BIM Coordination' },
    status: 'in_progress',
    estimatedStartDate: '2026-11-23',
    startDate: null,
    endDate: '2026-11-23',
    budgetHours: 3,
    remainingHours: 3,
    assigneeIds: [12],
    loggedUserIds: [],
    loggedHoursByUser: null,
    overdue: false,
    canDrag: true,
    pending: null,
    ...over,
  };
}

function person(id: number, over: Partial<TeamWorkloadPerson> = {}, planned: number[] = [0, 0, 0, 0, 0]): TeamWorkloadPerson {
  const days = DAYS.map((date, i) => ({ date, capacity: 8, planned: planned[i], logged: null, tasks: [] as TeamWorkloadPerson['days'][number]['tasks'] }));
  return {
    id,
    firstName: 'P',
    lastName: String(id),
    name: `P ${id}`,
    position: null,
    orgUnit: null,
    departmentId: 1,
    departmentName: 'Building',
    qualificationIds: [3],
    canDragFrom: false,
    loggedVisible: true,
    days,
    totals: { capacity: 40, planned: planned.reduce((a, b) => a + b, 0), logged: null, undatedHours: 0, overdueHours: 0, utilizationPct: 0, overloadedDays: 0 },
    ...over,
  };
}

const ASSIGN: WorkloadAssign = {
  canAssign: true,
  projects: { '59': { canManage: false, teamUserIds: [12, 34] } },
  services: { '7': { requiredQualificationIds: [3] } },
  approvalsWaitingForMe: 0,
};

function board(people: TeamWorkloadPerson[], tasks: WorkloadTaskEntry[] = [task()]): TeamWorkload {
  return {
    range: { from: DAYS[0], to: DAYS[4], today: DAYS[1] },
    workWeek: { restDays: REST, weekStartsOn: 0 },
    days: DAYS.map((date, i) => ({ date, dayOfWeek: i, isWorkingDay: true, holiday: null })),
    people,
    totals: { people: people.length, capacity: people.length * 40, planned: people.reduce((s, p) => s + p.totals.planned, 0), logged: null, undatedHours: 0, utilizationPct: 0 },
    orgUnits: [],
    scope: { myDeptOnly: false, orgUnitId: null, deptName: null },
    tasks: Object.fromEntries(tasks.map((t) => [String(t.id), t])),
    assign: ASSIGN,
  };
}

function withChip(p: TeamWorkloadPerson, dayIndex: number, taskId: number, hours: number, masked = false): TeamWorkloadPerson {
  const days = p.days.map((d, i) =>
    i === dayIndex
      ? { ...d, planned: d.planned + hours, tasks: [...d.tasks, masked
        ? { taskId: null, code: null, name: 'Other project', projectId: null, projectName: null, hours, masked: true as const }
        : { taskId, code: `T-${taskId}`, name: `Task ${taskId}`, projectId: 59, projectName: 'ניסוי 9', hours }] }
      : d,
  );
  return { ...p, days, totals: { ...p.totals, planned: p.totals.planned + hours } };
}

describe('canDragChip (server rule: pending == null && projectId != null && (canDrag || people[lane].canDragFrom))', () => {
  it('the project-manage flag or the manager-chain flag of the chip\'s person', () => {
    expect(canDragChip(task({ canDrag: true }), person(12))).toBe(true);
    expect(canDragChip(task({ canDrag: false }), person(12, { canDragFrom: true }))).toBe(true);
    expect(canDragChip(task({ canDrag: false }), person(12, { canDragFrom: false }))).toBe(false);
  });

  it('masked, pending and personal chips never move', () => {
    expect(canDragChip(null, person(12, { canDragFrom: true }))).toBe(false);
    expect(canDragChip(undefined, person(12))).toBe(false);
    const pending = { id: 881, fromUserId: 12, toUserId: 34, toName: 'Yair', approver: null, requestedBy: null, createdAt: null };
    expect(canDragChip(task({ pending }), person(12, { canDragFrom: true }))).toBe(false);
    expect(canDragChip(task({ projectId: null }), person(12, { canDragFrom: true }))).toBe(false);
    expect(canDragChip(task({ isPersonal: true }), person(12, { canDragFrom: true }))).toBe(false);
  });

  it('an unassigned tray chip has no person: leader / Admin only, even when no board chip is draggable', () => {
    expect(canDragChip(task({ canDrag: true }), null)).toBe(true);
    expect(canDragChip(task({ canDrag: false }), null)).toBe(false);
  });

  it('no drag right on either side: read-only', () => {
    expect(canDragChip(task({ canDrag: false }), person(12, { canDragFrom: false }))).toBe(false);
    expect(canDragChip(task({ canDrag: false }), null)).toBe(false);
  });
});

describe('mergeAssignProjects', () => {
  it('a tray task\'s project missing from the board comes from the tray', () => {
    const board = { '59': { canManage: false, teamUserIds: [12, 34] } };
    const tray = { '61': { canManage: true, teamUserIds: [56] } };
    expect(mergeAssignProjects(board, tray)).toEqual({ '59': board['59'], '61': tray['61'] });
    expect(mergeAssignProjects(board, undefined)).toBe(board);
    expect(mergeAssignProjects(board, {})).toBe(board);
  });

  it('a project in both: Team lists joined, either canManage counts', () => {
    expect(mergeAssignProjects({ '59': { canManage: false, teamUserIds: [12, 34] } }, { '59': { canManage: true, teamUserIds: [34, 56] } })).toEqual({
      '59': { canManage: true, teamUserIds: [12, 34, 56] },
    });
  });

  it('the drop check sees a tray-only project', () => {
    const outsider = person(56, { departmentId: 1 });
    const t = task({ id: 900, projectId: 61, assigneeIds: [], canDrag: false });
    const src = { fromUserId: null, fromDay: null };
    expect(dropCheck(outsider, t, { source: src, toDay: '2026-11-24', assign: { ...ASSIGN, projects: {} }, fromPerson: null }).reason).toBe('team');
    const merged = mergeAssignProjects({}, { '61': { canManage: false, teamUserIds: [56] } });
    expect(dropCheck(outsider, t, { source: src, toDay: '2026-11-24', assign: { ...ASSIGN, projects: merged }, fromPerson: null })).toMatchObject({ ok: true, addsToTeam: false });
  });
});

describe('providesService', () => {
  it('no service, or a service without a requirement: everyone', () => {
    expect(providesService(person(1, { qualificationIds: [] }), task({ service: null }), ASSIGN.services)).toBe(true);
    expect(providesService(person(1, { qualificationIds: [] }), task({ service: { id: 9, name: 'Other' } }), ASSIGN.services)).toBe(true);
    expect(providesService(person(1, { qualificationIds: [] }), task(), { '7': { requiredQualificationIds: [] } })).toBe(true);
  });

  it('a requirement: hold any one of the qualifications', () => {
    expect(providesService(person(1, { qualificationIds: [3] }), task(), { '7': { requiredQualificationIds: [3, 5] } })).toBe(true);
    expect(providesService(person(1, { qualificationIds: [5] }), task(), { '7': { requiredQualificationIds: [3, 5] } })).toBe(true);
    expect(providesService(person(1, { qualificationIds: [4] }), task(), { '7': { requiredQualificationIds: [3, 5] } })).toBe(false);
    expect(providesService(person(1, { qualificationIds: undefined }), task(), ASSIGN.services)).toBe(false);
  });
});

describe('dropCheck', () => {
  const daniel = person(12, { departmentId: 1 });
  const yair = person(34, { departmentId: 1 });
  const infra = person(56, { departmentId: 2, qualificationIds: [3] });
  const lane = { fromUserId: 12, fromDay: '2026-11-23' };

  it('same department, on the Team, provides the service: plain move', () => {
    expect(dropCheck(yair, task(), { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel })).toEqual({
      ok: true, reason: null, crossDept: false, needsApproval: false, addsToTeam: false,
    });
  });

  it('the chip\'s own cell refuses the drop; another day in the same row is a date move', () => {
    expect(dropCheck(daniel, task(), { source: lane, toDay: '2026-11-23', assign: ASSIGN, fromPerson: daniel })).toMatchObject({ ok: false, reason: 'same-cell' });
    expect(dropCheck(daniel, task(), { source: lane, toDay: '2026-11-25', assign: ASSIGN, fromPerson: daniel })).toMatchObject({ ok: true, crossDept: false });
    // Row-level check (dimming) never dims the chip's own row.
    expect(dropCheck(daniel, task(), { source: lane, toDay: null, assign: ASSIGN, fromPerson: daniel }).ok).toBe(true);
  });

  it('a column that is not an org working day refuses the drop (server 400 REASSIGN_INVALID_DAY), even in the own row', () => {
    expect(dropCheck(yair, task(), { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel, day: { isWorkingDay: false } })).toMatchObject({ ok: false, reason: 'not-working-day' });
    expect(dropCheck(daniel, task(), { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel, day: { isWorkingDay: false } })).toMatchObject({ ok: false, reason: 'not-working-day' });
    expect(dropCheck(yair, task({ assigneeIds: [] }), { source: { fromUserId: null, fromDay: null }, toDay: '2026-11-24', assign: ASSIGN, fromPerson: null, day: { isWorkingDay: false } }).reason).toBe('not-working-day');
    expect(dropCheck(yair, task(), { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel, day: { isWorkingDay: true } }).ok).toBe(true);
  });

  it('B already an assignee: the server only removes A, so no service / Team check and no team add', () => {
    const shared = task({ assigneeIds: [12, 77] });
    const outsiderNoQual = person(77, { qualificationIds: [], departmentId: 1 });
    expect(dropCheck(outsiderNoQual, shared, { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel })).toEqual({
      ok: true, reason: null, crossDept: false, needsApproval: false, addsToTeam: false,
    });
    // ...but D1 still applies to the merge.
    const otherDept = person(77, { qualificationIds: [], departmentId: 2 });
    expect(dropCheck(otherDept, shared, { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel })).toMatchObject({ ok: true, crossDept: true, needsApproval: true, addsToTeam: false });
  });

  it('service not provided: refused', () => {
    const noQual = person(34, { qualificationIds: [9] });
    expect(dropCheck(noQual, task(), { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel })).toMatchObject({ ok: false, reason: 'service' });
  });

  it('not on the Team: refused unless the caller manages the project (then he is added)', () => {
    const outsider = person(77);
    expect(dropCheck(outsider, task(), { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: daniel })).toMatchObject({ ok: false, reason: 'team' });
    const managed: WorkloadAssign = { ...ASSIGN, projects: { '59': { canManage: true, teamUserIds: [12, 34] } } };
    expect(dropCheck(outsider, task(), { source: lane, toDay: '2026-11-24', assign: managed, fromPerson: daniel })).toMatchObject({ ok: true, addsToTeam: true });
    // A project missing from the block: the task's own manage flag decides.
    const none: WorkloadAssign = { ...ASSIGN, projects: {} };
    expect(dropCheck(outsider, task({ canDrag: false }), { source: lane, toDay: '2026-11-24', assign: none, fromPerson: daniel })).toMatchObject({ ok: false, reason: 'team' });
    expect(dropCheck(outsider, task({ canDrag: true }), { source: lane, toDay: '2026-11-24', assign: none, fromPerson: daniel })).toMatchObject({ ok: true, addsToTeam: true });
  });

  it('cross-department compares departmentId; approval unless the caller is Admin / in the target\'s chain (D3)', () => {
    const managed: WorkloadAssign = { ...ASSIGN, projects: { '59': { canManage: false, teamUserIds: [12, 34, 56] } } };
    expect(dropCheck(infra, task(), { source: lane, toDay: '2026-11-24', assign: managed, fromPerson: daniel })).toEqual({
      ok: true, reason: null, crossDept: true, needsApproval: true, addsToTeam: false,
    });
    expect(dropCheck({ ...infra, canDragFrom: true }, task(), { source: lane, toDay: '2026-11-24', assign: managed, fromPerson: daniel })).toMatchObject({ crossDept: true, needsApproval: false });
    // Two people without a department share "No department".
    expect(departmentKey({ departmentId: null })).toBe(departmentKey({ departmentId: undefined }));
    const a = person(12, { departmentId: null });
    const b = person(34, { departmentId: null });
    expect(dropCheck(b, task(), { source: lane, toDay: '2026-11-24', assign: ASSIGN, fromPerson: a }).crossDept).toBe(false);
  });

  it('an unassigned tray chip is never cross-department (D4)', () => {
    const managed: WorkloadAssign = { ...ASSIGN, projects: { '59': { canManage: true, teamUserIds: [56] } } };
    expect(dropCheck(infra, task({ assigneeIds: [] }), { source: { fromUserId: null, fromDay: null }, toDay: '2026-11-24', assign: managed, fromPerson: null })).toMatchObject({ ok: true, crossDept: false, needsApproval: false });
  });

  it('an overdue tray item belongs to A (fromDay null): a cross-department target waits for approval', () => {
    const managed: WorkloadAssign = { ...ASSIGN, projects: { '59': { canManage: false, teamUserIds: [12, 34, 56] } } };
    const overdue = { fromUserId: 12, fromDay: null };
    expect(dropCheck(infra, task({ overdue: true }), { source: overdue, toDay: '2026-11-24', assign: managed, fromPerson: daniel })).toMatchObject({ ok: true, crossDept: true, needsApproval: true });
    // Same department: applied directly; back on A on any working day: a date move.
    expect(dropCheck(yair, task({ overdue: true }), { source: overdue, toDay: '2026-11-24', assign: managed, fromPerson: daniel })).toMatchObject({ ok: true, crossDept: false });
    expect(dropCheck(daniel, task({ overdue: true }), { source: overdue, toDay: '2026-11-23', assign: managed, fromPerson: daniel })).toMatchObject({ ok: true, crossDept: false });
  });

  it('reason words', () => {
    expect(dropReasonText('team')).toBe('Not on the project team');
    expect(dropReasonText('service', task())).toBe('Does not provide BIM Coordination');
    expect(dropReasonText('service', null)).toBe('Does not provide this service');
    expect(dropReasonText('same-cell')).toBe('Current day');
  });
});

describe('previewPct', () => {
  it('before→after on the drop cell; red above 100%', () => {
    expect(previewPct({ planned: 4, capacity: 8 }, 2)).toEqual({ before: 50, after: 75, over: false, off: false });
    expect(previewPct({ planned: 7, capacity: 8 }, 3)).toEqual({ before: 88, after: 125, over: true, off: false });
    expect(previewPct({ planned: 6, capacity: 8 }, 2).over).toBe(false); // exactly 100%
  });

  it('hours of the same task already in the cell are not counted twice', () => {
    expect(previewPct({ planned: 5, capacity: 8, sameTaskHours: 1 }, 1)).toMatchObject({ before: 63, after: 63 });
  });

  it('a day off: any hour is over', () => {
    expect(previewPct({ planned: 0, capacity: 0 }, 2)).toEqual({ before: 0, after: 0, over: true, off: true });
  });
});

describe('overloadCausing', () => {
  it('the smallest movable chip of every person-day above capacity, once per task and person', () => {
    let p = person(12);
    p = withChip(p, 1, 1, 6);
    p = withChip(p, 1, 2, 2.5);
    p = withChip(p, 2, 2, 2.5);
    p = withChip(p, 2, 3, 7);
    p = withChip(p, 3, 4, 3); // not overloaded
    const tasks = Object.fromEntries([1, 2, 3, 4].map((id) => [String(id), task({ id })]));
    expect(overloadCausing([p], tasks)).toEqual([{ taskId: 2, personId: 12, day: '2026-11-23', hours: 2.5 }]);
  });

  it('skips masked and pending chips', () => {
    let p = person(12);
    p = withChip(p, 0, 0, 1, true);
    p = withChip(p, 0, 5, 2);
    p = withChip(p, 0, 6, 7);
    const pending = { id: 1, fromUserId: 12, toUserId: 34, toName: null, approver: null, requestedBy: null, createdAt: null };
    const tasks = { '5': task({ id: 5, pending }), '6': task({ id: 6 }) };
    expect(overloadCausing([p], tasks)).toEqual([{ taskId: 6, personId: 12, day: '2026-11-22', hours: 7 }]);
  });
});

describe('days', () => {
  it('signed working-day columns between two days', () => {
    const days = DAYS.map((date) => ({ date, isWorkingDay: date !== '2026-11-24' }));
    expect(workingDayDelta(days, '2026-11-23', '2026-11-25')).toBe(1); // the holiday is skipped
    expect(workingDayDelta(days, '2026-11-26', '2026-11-22')).toBe(-3);
    expect(workingDayDelta(days, '2026-11-23', '2026-11-24')).toBeNull();
  });

  it('working days of the org week', () => {
    expect(workingDaysBetween('2026-11-26', '2026-11-29', REST)).toBe(2); // Thu + Sun
    expect(nextWorkingDays('2026-11-26', 3, REST)).toEqual(['2026-11-26', '2026-11-29', '2026-11-30']);
  });

  it('tray landing (D6): inside a live window the dates stay; otherwise the window starts on the drop day', () => {
    const t = task({ estimatedStartDate: '2026-11-23', endDate: '2026-11-24', remainingHours: 4 });
    expect(trayLandingDays(t, '2026-11-24', REST)).toEqual([{ date: '2026-11-23', hours: 2 }, { date: '2026-11-24', hours: 2 }]);
    expect(trayLandingDays(t, '2026-11-26', REST)).toEqual([{ date: '2026-11-26', hours: 2 }, { date: '2026-11-29', hours: 2 }]);
    expect(trayLandingDays({ ...t, overdue: true }, '2026-11-24', REST)).toEqual([{ date: '2026-11-24', hours: 2 }, { date: '2026-11-25', hours: 2 }]);
    expect(trayLandingDays({ ...t, remainingHours: 0 }, '2026-11-24', REST)).toEqual([]);
  });
});

describe('reassignBody', () => {
  const view = { from: '2026-11-22', to: '2026-11-26' };
  it('a lane chip to another person and day', () => {
    expect(reassignBody({ fromUserId: 12, fromDay: '2026-11-23' }, { userId: 34, day: '2026-11-24' }, view)).toEqual({
      fromUserId: 12, toUserId: 34, fromDay: '2026-11-23', toDay: '2026-11-24', view,
    });
  });
  it('from the tray (fromUserId null) and back to the tray (toUserId null)', () => {
    expect(reassignBody({ fromUserId: null, fromDay: null }, { userId: 34, day: '2026-11-24' }, view)).toMatchObject({ fromUserId: null, fromDay: null, toUserId: 34 });
    expect(reassignBody({ fromUserId: 12, fromDay: '2026-11-23' }, null, view)).toMatchObject({ fromUserId: 12, toUserId: null, toDay: null });
  });
  it('an overdue tray chip keeps its assignee as fromUserId, with no fromDay', () => {
    expect(reassignBody({ fromUserId: 12, fromDay: null }, { userId: 34, day: '2026-11-24' }, view)).toMatchObject({ fromUserId: 12, fromDay: null });
  });
});

describe('applyOptimisticMove', () => {
  const daniel = withChip(person(12), 1, 4021, 3);
  const yair = person(34);

  it('A → B, same day: A loses the hours, B gains them', () => {
    const next = applyOptimisticMove(board([daniel, yair]), { task: task(), fromUserId: 12, toUserId: 34, fromDay: '2026-11-23', toDay: '2026-11-23' });
    expect(next.people[0].days[1]).toMatchObject({ planned: 0, tasks: [] });
    expect(next.people[0].totals.planned).toBe(0);
    expect(next.people[1].days[1].planned).toBe(3);
    expect(next.people[1].days[1].tasks[0]).toMatchObject({ taskId: 4021, hours: 3 });
    expect(next.people[1].totals).toMatchObject({ planned: 3, utilizationPct: 8 });
    expect(next.tasks!['4021'].assigneeIds).toEqual([34]);
    expect(next.totals.planned).toBe(3);
  });

  it('A → B on another day: shifted by the working-day delta', () => {
    const next = applyOptimisticMove(board([daniel, yair]), { task: task(), fromUserId: 12, toUserId: 34, fromDay: '2026-11-23', toDay: '2026-11-25' });
    expect(next.people[1].days[3].planned).toBe(3);
    expect(next.people[1].days[1].planned).toBe(0);
  });

  it('same person, another day: a date move in the row; a chip shifted out of the week leaves the view', () => {
    let two = withChip(person(12), 3, 4021, 1);
    two = withChip(two, 4, 4021, 1);
    const next = applyOptimisticMove(board([two]), { task: task(), fromUserId: 12, toUserId: 12, fromDay: '2026-11-25', toDay: '2026-11-26' });
    expect(next.people[0].days.map((d) => d.planned)).toEqual([0, 0, 0, 0, 1]);
    expect(next.tasks!['4021'].assigneeIds).toEqual([12]);
  });

  it('B already has the task: the hours merge into his chip', () => {
    const both = withChip(person(34), 1, 4021, 1.5);
    const next = applyOptimisticMove(board([daniel, both], [task({ assigneeIds: [12, 34] })]), { task: task({ assigneeIds: [12, 34] }), fromUserId: 12, toUserId: 34, fromDay: '2026-11-23', toDay: '2026-11-23' });
    expect(next.people[1].days[1].tasks).toHaveLength(1);
    expect(next.people[1].days[1].tasks[0].hours).toBe(4.5);
    expect(next.tasks!['4021'].assigneeIds).toEqual([34]);
  });

  it('drop on the tray: A loses the chips and the task has no assignee', () => {
    const next = applyOptimisticMove(board([daniel]), { task: task(), fromUserId: 12, toUserId: null, fromDay: '2026-11-23', toDay: null });
    expect(next.people[0].totals.planned).toBe(0);
    expect(next.tasks!['4021'].assigneeIds).toEqual([]);
  });

  it('from the tray: lands by the D6 rule and the task joins the index', () => {
    const t = task({ id: 900, assigneeIds: [], estimatedStartDate: '2026-11-23', endDate: '2026-11-24', remainingHours: 4 });
    const next = applyOptimisticMove(board([yair], []), { task: t, fromUserId: null, toUserId: 34, fromDay: null, toDay: '2026-11-24' });
    expect(next.people[0].days.map((d) => d.planned)).toEqual([0, 2, 2, 0, 0]);
    expect(next.tasks!['900'].assigneeIds).toEqual([34]);
  });

  it('a pending move only gets the badge: A keeps the load', () => {
    const pending = { id: 881, fromUserId: 12, toUserId: 56, toName: 'Gal', approver: null, requestedBy: null, createdAt: null };
    const before = board([daniel, yair]);
    const next = applyOptimisticMove(before, { task: task(), fromUserId: 12, toUserId: 56, fromDay: '2026-11-23', toDay: '2026-11-23', pending });
    expect(next.people).toBe(before.people);
    expect(next.tasks!['4021'].pending).toEqual(pending);
  });
});

describe('server rows and task patch', () => {
  it('replaces the touched people, keeps fields the row leaves out, ignores another week', () => {
    const data = board([person(12, { canDragFrom: true }), person(34)]);
    const row = { ...person(12, {}, [0, 4, 0, 0, 0]) } as any;
    delete row.canDragFrom;
    delete row.departmentId;
    const next = applyPeopleRows(data, [row]);
    expect(next.people[0].days[1].planned).toBe(4);
    expect(next.people[0].canDragFrom).toBe(true);
    expect(next.people[0].departmentId).toBe(1);
    expect(next.totals.planned).toBe(4);
    const otherWeek = { ...row, days: row.days.map((d: any) => ({ ...d, date: `x${d.date}` })) };
    expect(applyPeopleRows(data, [otherWeek]).people[0].days[1].planned).toBe(0);
  });

  it('patches assignees, dates and pending', () => {
    const data = board([person(12)]);
    const next = applyTaskPatch(data, { id: 4021, assigneeIds: [34], estimatedStartDate: '2026-11-24', endDate: '2026-11-24', dueDateOverridden: true }, null, 4021);
    expect(next.tasks!['4021']).toMatchObject({ assigneeIds: [34], estimatedStartDate: '2026-11-24', endDate: '2026-11-24', pending: null });
    const pending = { id: 881, fromUserId: 12, toUserId: 56, toName: 'Gal', approver: null, requestedBy: null, createdAt: null };
    expect(applyTaskPatch(data, null, pending, 4021).tasks!['4021'].pending).toEqual(pending);
    expect(applyTaskPatch(data, null, undefined, 999)).toBe(data);
  });
});

describe('applyTrayMove', () => {
  const tray: WorkloadTray = {
    range: { from: DAYS[0], to: DAYS[4], today: DAYS[4] },
    assign: { projects: {} },
    unassigned: { total: 3, items: [task({ id: 900, assigneeIds: [] })] },
    overdue: { total: 1, items: [{ ...task({ id: 901, overdue: true }), assigneeId: 12, assigneeName: 'Daniel Huri' }] },
    approvals: [],
  };

  it('an assigned tray chip leaves its group', () => {
    expect(applyTrayMove(tray, { task: tray.unassigned.items[0], fromUserId: null, toUserId: 34, fromDay: null, toDay: '2026-11-24', origin: 'unassigned' }).unassigned).toEqual({ total: 2, items: [] });
    expect(applyTrayMove(tray, { task: tray.overdue.items[0], fromUserId: 12, toUserId: 34, fromDay: null, toDay: '2026-11-24', origin: 'overdue' }).overdue).toEqual({ total: 0, items: [] });
  });

  it('a drop on the tray adds the task to Unassigned when nobody is left on it', () => {
    const next = applyTrayMove(tray, { task: task(), fromUserId: 12, toUserId: null, fromDay: '2026-11-23', toDay: null, origin: 'lane' });
    expect(next.unassigned.total).toBe(4);
    expect(next.unassigned.items[0]).toMatchObject({ id: 4021, assigneeIds: [] });
    const shared = applyTrayMove(tray, { task: task({ assigneeIds: [12, 34] }), fromUserId: 12, toUserId: null, fromDay: '2026-11-23', toDay: null, origin: 'lane' });
    expect(shared.unassigned.total).toBe(3);
  });
});

describe('toast text', () => {
  const base = {
    result: 'applied' as const,
    reassignment: { id: 881, status: 'applied', crossDepartment: false, approver: null, undoUntil: null },
    changed: { assignee: true, dates: false },
    addedToTeam: false,
    loggedStays: null,
    warnings: [],
  };
  const ctx = { taskLabel: 'CRD-040', fromName: 'Daniel Huri', toName: 'Yair Goldfryd', toDay: '2026-11-24', otherAssigneeNames: [] };

  it('a move, a date move, a tray assign and an unassign', () => {
    expect(reassignToastText(base, ctx).title).toBe('CRD-040 moved to Yair Goldfryd');
    expect(reassignToastText({ ...base, changed: { assignee: true, dates: true } }, ctx).title).toBe('CRD-040 moved to Yair Goldfryd, Tue 24/11');
    expect(reassignToastText({ ...base, changed: { assignee: false, dates: true } }, { ...ctx, toName: 'Daniel Huri' }).title).toBe('CRD-040 moved to Tue 24/11');
    expect(reassignToastText(base, { ...ctx, fromName: null }).title).toBe('CRD-040 assigned to Yair Goldfryd');
    expect(reassignToastText(base, { ...ctx, toName: null, toDay: null }).title).toBe('CRD-040 unassigned from Daniel Huri');
  });

  it('logged hours stay (⏱), D7 note, team add and warnings', () => {
    const { description } = reassignToastText(
      {
        ...base,
        changed: { assignee: true, dates: true },
        addedToTeam: true,
        loggedStays: { userId: 12, name: 'Daniel Huri', hours: 1.5 },
        warnings: [{ code: 'PREDECESSOR_OVERLAP', taskId: 4019, message: 'CRD-039 ends after the new start' }],
      },
      { ...ctx, otherAssigneeNames: ['Roee Naor'] },
    );
    expect(description).toContain('⏱ 1.5h already logged stay with Daniel Huri.');
    expect(description).toContain('The new dates also move the share of Roee Naor.');
    expect(description).toContain('Yair Goldfryd was added to the project team.');
    expect(description).toContain('CRD-039 ends after the new start.');
    expect(reassignToastText({ ...base, loggedStays: { userId: 12, name: 'Daniel Huri', hours: null } }, ctx).description).toBe('⏱ Hours already logged stay with Daniel Huri.');
  });

  it('pending: names the approver, or an Admin', () => {
    const pending = { ...base, result: 'pending' as const, reassignment: { ...base.reassignment, status: 'pending', crossDepartment: true, approver: { id: 5, name: 'Amit Maimoni' } } };
    expect(reassignToastText(pending, ctx)).toEqual({
      title: 'Approval requested: CRD-040 to Yair Goldfryd',
      description: 'The task stays with Daniel Huri until Amit Maimoni approves.',
    });
    expect(reassignToastText({ ...pending, reassignment: { ...pending.reassignment, approver: null } }, ctx).description).toContain('until an Admin approves');
  });

  const KEYS = [
    'ASSIGNEE_NOT_ON_TEAM', 'REASSIGN_NOT_ALLOWED', 'SERVICE_NOT_PROVIDED', 'REASSIGN_INVALID_DAY', 'REASSIGN_STALE',
    'REASSIGN_PENDING', 'REASSIGN_NOT_PENDING', 'UNDO_EXPIRED', 'UNDO_STALE', 'REASSIGN_LIST_INVALID',
  ];

  it('every error key has clear words; others use the generic error', () => {
    for (const key of KEYS) expect(reassignErrorText(key)).not.toBeNull();
    expect(reassignErrorText('BAD_REQUEST')).toBeNull();
    expect(reassignErrorText(null)).toBeNull();
    expect(reassignErrorText('UNDO_EXPIRED')!.description).toBe('The 15 minutes to undo this move have passed.');
    expect(reassignErrorText('REASSIGN_STALE')!.description).toContain('tray were refreshed');
    expect(reassignErrorText('REASSIGN_NOT_PENDING')!.title).toBe('Already decided');
  });

  it('a 403 is worded by details.reason (PERMISSION_DENIED convention); an expired undo by its reason', () => {
    expect(reassignErrorKey('PERMISSION_DENIED', { module: 'tasks', reason: 'REASSIGN_NOT_ALLOWED' })).toBe('REASSIGN_NOT_ALLOWED');
    expect(reassignErrorKey('PERMISSION_DENIED', { module: 'projects', reason: 'ASSIGNEE_NOT_ON_TEAM' })).toBe('ASSIGNEE_NOT_ON_TEAM');
    // A permission 403 without a reason keeps the generic "No permission" card.
    expect(reassignErrorKey('PERMISSION_DENIED', null)).toBe('PERMISSION_DENIED');
    expect(reassignErrorText(reassignErrorKey('PERMISSION_DENIED', {}))).toBeNull();
    expect(reassignErrorKey('UNDO_STALE', { reason: 'UNDO_EXPIRED' })).toBe('UNDO_EXPIRED');
    expect(reassignErrorKey('UNDO_STALE', null)).toBe('UNDO_STALE');
    expect(reassignErrorKey('REASSIGN_STALE', { reason: 'ANY' })).toBe('REASSIGN_STALE');
    expect(reassignErrorKey(null, null)).toBeNull();
  });

  it('the approver\'s toast: logged hours and warnings from the approve response', () => {
    const r = { task: { code: 'CRD-040', name: 'x' }, from: { name: 'Daniel Huri' }, to: { name: 'Gal Haviv' } };
    expect(approveToastText({ loggedStays: null, warnings: [], addedToTeam: false }, r)).toEqual({ title: 'Approved: CRD-040 moves to Gal Haviv', description: '' });
    const full = approveToastText(
      { loggedStays: { userId: 12, name: 'Daniel Huri', hours: 2 }, warnings: [{ code: 'SUCCESSOR_OVERLAP', taskId: 1, message: 'CRD-041 starts on or before the new end date' }], addedToTeam: true },
      r,
    );
    expect(full.description).toBe('Gal Haviv was added to the project team. ⏱ 2h already logged stay with Daniel Huri. CRD-041 starts on or before the new end date.');
  });

  it('no long dashes in any text the user sees', () => {
    const texts = [
      ...KEYS.flatMap((c) => Object.values(reassignErrorText(c)!)),
      ...(['same-cell', 'not-working-day', 'service', 'team'] as const).map((r) => dropReasonText(r, task())),
      ...Object.values(reassignToastText({ ...base, result: 'pending' }, ctx)),
    ];
    for (const t of texts) expect(t).not.toMatch(/[–—]/);
  });
});

describe('contract adapters', () => {
  it('an older team payload (no tasks / assign / PR-063 person fields) is read-only, not broken', () => {
    const w = normalizeTeamWorkload({ people: [{ id: 12, days: [], totals: {} }], days: [] });
    expect(w.tasks).toEqual({});
    expect(w.assign).toEqual(EMPTY_ASSIGN);
    expect(w.people[0]).toMatchObject({ departmentId: null, qualificationIds: [], canDragFrom: false });
  });

  it('task entries: ids coerced, masked rows (no id) dropped, pending read', () => {
    const w = normalizeTeamWorkload({
      people: [],
      days: [],
      tasks: {
        '4021': { id: 4021, code: 'CRD-040', name: 'x', projectId: 59, assigneeIds: ['12'], loggedUserIds: [12], loggedHoursByUser: { '12': '1.5' }, canDrag: true,
          pending: { id: 881, fromUserId: 12, toUserId: 34, toName: 'Yair', approver: null, requestedBy: { id: 9, name: 'Nitzan' }, createdAt: '2026-11-26T10:00:00Z' } },
        bad: { code: 'X' },
      },
      assign: { canAssign: true, projects: { '59': { canManage: true, teamUserIds: [12, '34'] } }, services: { '7': { requiredQualificationIds: [3] } }, approvalsWaitingForMe: 2 },
    });
    expect(Object.keys(w.tasks!)).toEqual(['4021']);
    expect(w.tasks!['4021']).toMatchObject({ assigneeIds: [12], loggedHoursByUser: { '12': 1.5 }, pending: { id: 881, toName: 'Yair', requestedBy: { id: 9, name: 'Nitzan' } } });
    expect(w.assign!.projects['59'].teamUserIds).toEqual([12, 34]);
    expect(w.assign!.approvalsWaitingForMe).toBe(2);
  });

  it('tray: overdue items need an assignee; totals never below the list', () => {
    const tray = normalizeTray({
      unassigned: { total: 1, items: [{ id: 1, name: 'a', projectId: 59 }, { id: 2, name: 'b', projectId: 59 }] },
      overdue: { total: 5, items: [{ id: 3, name: 'c', projectId: 59, assigneeId: 12, assigneeName: 'Daniel Huri' }, { id: 4, name: 'd' }] },
      approvals: [{ id: 881, status: 'pending', task: { id: 4021, code: 'CRD-040', name: 'x', projectId: 59, projectName: 'p', hours: 3 }, from: { id: 12, name: 'Daniel Huri' }, to: { id: 56, name: 'Gal Haviv' }, toDay: '2026-11-24' }, { id: 2 }],
    });
    expect(tray.unassigned.total).toBe(2);
    expect(tray.overdue.items.map((i) => i.id)).toEqual([3]);
    expect(tray.overdue.total).toBe(5);
    expect(tray.approvals).toHaveLength(1);
    expect(tray.approvals[0]).toMatchObject({ id: 881, task: { code: 'CRD-040', hours: 3 }, to: { name: 'Gal Haviv' }, toDay: '2026-11-24' });
    expect(normalizeTray(undefined)).toEqual({ range: null, unassigned: { total: 0, items: [] }, overdue: { total: 0, items: [] }, approvals: [], assign: { projects: {} } });
  });

  it('tray: range and assign.projects (same shape as the board\'s)', () => {
    const tray = normalizeTray({
      range: { from: '2026-11-22', to: '2026-11-26', today: '2026-11-26' },
      unassigned: { total: 0, items: [] },
      overdue: { total: 0, items: [] },
      approvals: [],
      assign: { projects: { '61': { canManage: true, teamUserIds: [56, '78'] }, bad: { canManage: true } } },
    });
    expect(tray.range).toEqual({ from: '2026-11-22', to: '2026-11-26', today: '2026-11-26' });
    expect(tray.assign.projects).toEqual({ '61': { canManage: true, teamUserIds: [56, 78] } });
  });

  it('loggedHoursByUser may be null', () => {
    const t = normalizeTaskEntry({ id: 1, name: 'x', projectId: 59, loggedUserIds: [12], loggedHoursByUser: null })!;
    expect(t.loggedHoursByUser).toBeNull();
    expect(t.loggedUserIds).toEqual([12]);
    expect(normalizeTaskEntry({ id: 1, name: 'x', projectId: 59 })!.loggedHoursByUser).toBeNull();
  });

  it('decision responses: approve (full outcome), reject (result + reassignment), undo (no outcome fields)', () => {
    const approve = normalizeDecisionResponse({
      result: 'approved',
      reassignment: { id: 881, status: 'approved', crossDepartment: true, approver: { id: 5, name: 'Amit' }, undoUntil: '2026-11-26T10:30:00Z' },
      task: { id: 4021, assigneeIds: [56], estimatedStartDate: '2026-11-24', endDate: '2026-11-24', dueDateOverridden: true },
      people: [{ id: 12, days: [] }, { id: 56, days: [] }],
      changed: { assignee: true, dates: true },
      addedToTeam: true,
      loggedStays: { userId: 12, name: 'Daniel Huri', hours: 1.5 },
      warnings: [{ code: 'PREDECESSOR_OVERLAP', taskId: 4019, message: 'CRD-039 ends after the new start' }],
    });
    expect(approve).toMatchObject({ result: 'approved', reassignment: { id: 881, status: 'approved' }, task: { assigneeIds: [56] }, addedToTeam: true, loggedStays: { hours: 1.5 } });
    expect(approve.people).toHaveLength(2);
    expect(approve.warnings).toHaveLength(1);
    const reject = normalizeDecisionResponse({ result: 'rejected', reassignment: { id: 881, status: 'rejected' } });
    expect(reject).toMatchObject({ result: 'rejected', reassignment: { id: 881 }, task: null, people: [], loggedStays: null, warnings: [] });
    const undo = normalizeDecisionResponse({ result: 'cancelled', reassignment: { id: 881, status: 'cancelled' }, task: null, people: [] });
    expect(undo).toMatchObject({ result: 'cancelled', addedToTeam: false, changed: { assignee: false, dates: false } });
  });

  it('reassign response: defaults and loggedStays', () => {
    const r = normalizeReassignResponse({
      result: 'pending',
      reassignment: { id: 881, status: 'pending', crossDepartment: true, approver: null, undoUntil: '2026-11-26T10:15:00Z' },
      task: { id: 4021, assigneeIds: [12], estimatedStartDate: '2026-11-23', endDate: '2026-11-23', dueDateOverridden: false },
      loggedStays: { userId: 12, name: 'Daniel Huri', hours: null },
      people: [{ id: 12, days: [] }, { nope: true }],
    });
    expect(r.result).toBe('pending');
    expect(r.reassignment.crossDepartment).toBe(true);
    expect(r.loggedStays).toEqual({ userId: 12, name: 'Daniel Huri', hours: null });
    expect(r.people).toHaveLength(1);
    expect(r.warnings).toEqual([]);
    expect(normalizeReassignResponse({}).result).toBe('applied');
  });

  it('personal tasks: the server flag, or no project', () => {
    expect(isPersonalTask({ projectId: null })).toBe(true);
    expect(isPersonalTask({ projectId: 59, isPersonal: true })).toBe(true);
    expect(isPersonalTask({ projectId: 59 })).toBe(false);
    expect(normalizeTaskEntry({ id: 1, projectId: 59, isPersonal: true })!.isPersonal).toBe(true);
  });
});
