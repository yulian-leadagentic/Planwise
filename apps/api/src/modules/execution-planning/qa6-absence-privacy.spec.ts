/**
 * QA6 security review (2026-11-25) — absences are HR data.
 *
 * The workload engine cuts a person's capacity on an absence day. That
 * cut used to be applied for EVERY person on every workload surface, so
 * anyone with operations:read (or project access) could read an
 * employee's sick / vacation days off a shorter capacity bar. The rule
 * now follows round 3 (EmployeeScopeService): absences reduce capacity
 * only for people in the caller's `visibleUserIds` (self, manager chain;
 * `'all'` for hr:read). For anyone else no AbsenceRecord is read and the
 * capacity is the full one.
 *
 * Person 30 is absent for a whole day. Manager 20 manages his unit,
 * stranger 77 neither manages him nor holds hr:read.
 */
import { ExecutionPlanningController } from './execution-planning.controller';
import { ExecutionPlanningService } from './execution-planning.service';
import { addDaysYmd, workWeekOf } from './workload-engine';
import { loadPeopleInputs, todayKey } from './workload-loader';

const PERSON = 30;
const MANAGER = 20;
const STRANGER = 77;

const STRANGER_SCOPE = [STRANGER];
const MANAGER_SCOPE = [MANAGER, PERSON];
const HR_SCOPE = 'all' as const;

// This work week (Sun–Thu) and the next one; the absence is on the next
// week's Tuesday so it is always in the future (feasibility starts today).
const WEEK = workWeekOf(todayKey(), [5, 6]);
const NEXT_FROM = addDaysYmd(WEEK.from, 7);
const ABSENT_DAY = addDaysYmd(NEXT_FROM, 2); // Tuesday
const NEXT_TO = addDaysYmd(NEXT_FROM, 6);

const at = (d: string) => new Date(`${d}T00:00:00Z`);

function makePrisma(absentDay: string = ABSENT_DAY) {
  const people = [MANAGER, PERSON, STRANGER].map((id) => ({
    id,
    firstName: `U${id}`,
    lastName: 'L',
    position: null,
    avatarUrl: null,
    dailyStandardHours: 8,
    orgUnitId: 5,
    orgUnit: { id: 5, name: 'BIM' },
  }));
  const absences = [
    { userId: PERSON, dateFrom: at(absentDay), dateTo: at(absentDay), amount: 1, absenceType: { unit: 'DAY' } },
  ];
  const prisma: any = {
    hrSettings: { findFirst: jest.fn(async () => ({ weeklyRestDays: [5, 6] })) },
    calendarDay: { findMany: jest.fn(async () => []) },
    orgUnit: { findMany: jest.fn(async () => [{ id: 5, name: 'BIM', parentId: null, path: '/5/', depth: 0, sortOrder: 0 }]) },
    user: {
      findUnique: jest.fn(async () => ({ orgUnitId: 5, orgUnit: { id: 5, name: 'BIM' } })),
      findMany: jest.fn(async ({ where }: any = {}) =>
        where?.id?.in ? people.filter((p) => where.id.in.includes(p.id)) : people,
      ),
    },
    workSchedule: { findMany: jest.fn(async () => []) },
    // Honours the ids asked for, as the database would.
    absenceRecord: {
      findMany: jest.fn(async ({ where }: any) => absences.filter((a) => where.userId.in.includes(a.userId))),
    },
    taskAssignee: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
    timeEntry: { groupBy: jest.fn(async () => []), aggregate: jest.fn(async () => ({ _sum: { minutes: 0 } })) },
    project: {
      findFirst: jest.fn(async () => ({ leader: { id: MANAGER, firstName: 'U20', lastName: 'L', position: null } })),
      findMany: jest.fn(async () => []),
      findUniqueOrThrow: jest.fn(async () => ({ id: 59, name: 'P', endDate: at(NEXT_TO), budget: null })),
    },
    projectMember: {
      findMany: jest.fn(async () => [{ userId: PERSON, role: 'Modeler', user: { id: PERSON, firstName: 'U30', lastName: 'L', position: null } }]),
    },
    projectPartnerRole: { findMany: jest.fn(async () => []) },
    task: {
      // Feasibility (`projectId: 59`): one open task of person 30, far
      // more hours than he has. The dashboard's lists: nothing.
      findMany: jest.fn(async ({ where }: any) =>
        typeof where?.projectId === 'number'
          ? [
              {
                id: 1, name: 'Big', budgetHours: 1000, dependencies: [],
                assignees: [{ userId: PERSON, user: { id: PERSON, firstName: 'U30', lastName: 'L' } }],
              },
            ]
          : [],
      ),
    },
  };
  return prisma;
}

function service(prisma = makePrisma()) {
  const access: any = { getAccessibleProjectIds: jest.fn(async () => ({ all: true, projectIds: [] })) };
  return { svc: new ExecutionPlanningService(prisma, access), prisma };
}

describe('QA6 · absences reduce capacity only inside the caller’s round-3 scope', () => {
  it('loadPeopleInputs reads absences only for the ids in `absencesFor`; none at all for an empty scope', async () => {
    const prisma = makePrisma();
    const outside = await loadPeopleInputs(prisma, [PERSON, STRANGER], NEXT_FROM, NEXT_TO, {
      loggedFor: [],
      absencesFor: STRANGER_SCOPE,
    });
    expect(prisma.absenceRecord.findMany.mock.calls[0][0].where.userId).toEqual({ in: [STRANGER] });
    expect(outside.get(PERSON)!.absences).toEqual([]);

    const none = makePrisma();
    await loadPeopleInputs(none, [PERSON], NEXT_FROM, NEXT_TO, { loggedFor: [], absencesFor: [] });
    expect(none.absenceRecord.findMany).not.toHaveBeenCalled();

    const hr = await loadPeopleInputs(makePrisma(), [PERSON], NEXT_FROM, NEXT_TO, { loggedFor: [], absencesFor: HR_SCOPE });
    expect(hr.get(PERSON)!.absences).toHaveLength(1);
  });

  describe('GET /workload/team', () => {
    const dayOf = (out: any, date: string) =>
      out.people.find((p: any) => p.id === PERSON).days.find((d: any) => d.date === date);

    it('a non-HR, non-manager caller sees FULL capacity on the absence day', async () => {
      const out: any = await service().svc.getTeamWorkload(
        { id: STRANGER, isAdmin: false, visibleUserIds: STRANGER_SCOPE },
        { from: NEXT_FROM, to: NEXT_TO },
      );
      expect(dayOf(out, ABSENT_DAY).capacity).toBe(8);
      expect(out.people.find((p: any) => p.id === PERSON).totals.capacity).toBe(40);
    });

    it('HR and the manager see it reduced', async () => {
      for (const visibleUserIds of [HR_SCOPE, MANAGER_SCOPE] as const) {
        const out: any = await service().svc.getTeamWorkload(
          { id: MANAGER, isAdmin: false, visibleUserIds: visibleUserIds as any },
          { from: NEXT_FROM, to: NEXT_TO },
        );
        expect(dayOf(out, ABSENT_DAY).capacity).toBe(0);
        expect(out.people.find((p: any) => p.id === PERSON).totals.capacity).toBe(32);
      }
    });
  });

  describe('GET /projects/:id/workload', () => {
    const capacityOn = (out: any, date: string) =>
      out.members.find((m: any) => m.user.id === PERSON).workload.dailyData.find((d: any) => d.date === date).capacityHours;

    it('outside the scope: full capacity; manager / HR: reduced', async () => {
      const viewer = { id: STRANGER, isAdmin: false };
      const stranger: any = await service().svc.getProjectWorkload(59, NEXT_FROM, NEXT_TO, STRANGER_SCOPE, viewer);
      expect(capacityOn(stranger, ABSENT_DAY)).toBe(8);
      const manager: any = await service().svc.getProjectWorkload(59, NEXT_FROM, NEXT_TO, MANAGER_SCOPE, { id: MANAGER, isAdmin: false });
      expect(capacityOn(manager, ABSENT_DAY)).toBe(0);
      const hr: any = await service().svc.getProjectWorkload(59, NEXT_FROM, NEXT_TO, HR_SCOPE, viewer);
      expect(capacityOn(hr, ABSENT_DAY)).toBe(0);
    });
  });

  describe('GET /dashboard/operations (Team by Department)', () => {
    // The dashboard reads THIS work week; put the absence on its Monday.
    const THIS_WEEK_DAY = addDaysYmd(WEEK.from, 1);
    const capacityOf = (out: any) =>
      out.departments[0].members.find((m: any) => m.id === PERSON).capacity;

    it('the week capacity ignores the absence outside the scope, and counts it for the manager and HR', async () => {
      const stranger: any = await service(makePrisma(THIS_WEEK_DAY)).svc.getOperationsDashboard({
        id: STRANGER, isAdmin: false, visibleUserIds: STRANGER_SCOPE,
      });
      expect(capacityOf(stranger)).toBe(40);
      expect(stranger.departments[0].totalCapacity).toBe(120);

      for (const visibleUserIds of [HR_SCOPE, MANAGER_SCOPE] as const) {
        const out: any = await service(makePrisma(THIS_WEEK_DAY)).svc.getOperationsDashboard({
          id: MANAGER, isAdmin: false, visibleUserIds: visibleUserIds as any,
        });
        expect(capacityOf(out)).toBe(32);
      }
    });
  });

  describe('feasibility', () => {
    const available = async (scope: any) => {
      const out: any = await service().svc.calculateFeasibility(59, undefined, scope);
      return out.details.overloadedAssignees.find((a: any) => a.userId === PERSON).availableHours as number;
    };

    it('an assignee’s available hours drop by the absence only inside the caller’s scope', async () => {
      const outside = await available(STRANGER_SCOPE);
      expect(await available(MANAGER_SCOPE)).toBe(outside - 8);
      expect(await available(HR_SCOPE)).toBe(outside - 8);
      // No scope given = nobody's absences (fail closed).
      const svc = service();
      const def: any = await svc.svc.calculateFeasibility(59);
      expect(def.details.overloadedAssignees[0].availableHours).toBe(outside);
      expect(svc.prisma.absenceRecord.findMany).not.toHaveBeenCalled();
    });
  });

  describe('controller wiring', () => {
    function ctrl(visible: any = [7, 30]) {
      const eps: any = {
        getUserWorkload: jest.fn(async () => ({})),
        calculateFeasibility: jest.fn(async () => ({ status: 'OK' })),
      };
      const access: any = {
        assertProjectAccess: jest.fn(async () => undefined),
        getAccessibleProjectIds: jest.fn(async () => ({ all: false, projectIds: [59] })),
      };
      const scope: any = { visibleUserIds: jest.fn(async () => visible), canViewEmployee: jest.fn(async () => true) };
      return { c: new ExecutionPlanningController(eps, access, scope), eps, scope };
    }

    it('feasibility passes the caller’s visible ids', async () => {
      const { c, eps } = ctrl();
      await c.getFeasibility({ id: 7, isAdmin: false }, 59, '2026-12-31');
      expect(eps.calculateFeasibility).toHaveBeenCalledWith(59, '2026-12-31', [7, 30]);
    });

    it('/workload/user/:id (already canViewEmployee) and /workload/me show that person’s absences', async () => {
      const { c, eps } = ctrl();
      await c.getUserWorkload({ id: 7, isAdmin: false }, 30, 'a', 'b');
      expect(eps.getUserWorkload.mock.calls[0][3].absencesFor).toEqual([30]);
      await c.getMyWorkload({ id: 7, isAdmin: false }, 'a', 'b');
      expect(eps.getUserWorkload.mock.calls[1][3].absencesFor).toEqual([7]);
    });

    it('/workload/me masks his tasks on projects he can no longer open; personal tasks stay (finding 3)', async () => {
      const { c, eps } = ctrl();
      await c.getMyWorkload({ id: 7, isAdmin: false }, 'a', 'b');
      const { canSeeProject } = eps.getUserWorkload.mock.calls[0][3];
      expect(canSeeProject(59)).toBe(true);
      expect(canSeeProject(60)).toBe(false);
      expect(canSeeProject(null)).toBe(true);
    });
  });
});
