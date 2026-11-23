/**
 * Permissions round 4 (2026-11-23) — GET /dashboard/manager follows the
 * access rule (`getAccessibleProjectIds`), not ProjectMember rows only:
 * a leader sees the projects he leads and his org unit's projects even
 * without a membership row; an Admin sees every project.
 */
import { ExecutionPlanningController } from './execution-planning.controller';

function make(accessible: { all: boolean; projectIds: number[] }) {
  const projects = [
    { id: 59, name: 'Led, no membership', status: 'active', leader: { id: 7 }, _count: { tasks: 4, members: 0, zones: 1 } },
    { id: 61, name: 'Org unit project', status: 'active', leader: { id: 30 }, _count: { tasks: 2, members: 3, zones: 2 } },
  ];
  const prisma: any = {
    projectMember: { findMany: jest.fn(async () => []) },
    project: {
      findMany: jest.fn(async (args: any) =>
        args.where.id ? projects.filter((p) => args.where.id.in.includes(p.id)) : projects,
      ),
    },
    task: { count: jest.fn(async () => 1) },
  };
  const eps: any = {
    prisma,
    getProjectProgress: jest.fn(async () => ({ overallProgress: 50, statusCounts: {} })),
    calculateFeasibility: jest.fn(async () => ({ status: 'ON_TRACK' })),
  };
  const access: any = { getAccessibleProjectIds: jest.fn(async () => accessible) };
  const ctrl = new ExecutionPlanningController(eps, access, {} as any);
  return { ctrl, prisma, access };
}

describe('GET /dashboard/manager — access rule (round 4)', () => {
  it('includes the projects the user leads and his org unit\'s projects (no membership rows)', async () => {
    // getAccessibleProjectIds admits 59 (leader) and 61 (same org unit).
    const { ctrl, prisma, access } = make({ all: false, projectIds: [59, 61] });
    const out: any = await ctrl.getManagerDashboard({ id: 7, isAdmin: false });

    expect(access.getAccessibleProjectIds).toHaveBeenCalledWith(7, false);
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
    expect(out.projects.map((p: any) => p.project.id)).toEqual([59, 61]);
    expect(out.kpis.totalProjects).toBe(2);
    expect(out.kpis.totalTasks).toBe(6);
    expect(prisma.task.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: { in: [59, 61] } }) }),
    );
  });

  it('an Admin gets every live project', async () => {
    const { ctrl, prisma } = make({ all: true, projectIds: [] });
    const out: any = await ctrl.getManagerDashboard({ id: 1, isAdmin: true });
    expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
    expect(out.kpis.totalProjects).toBe(2);
  });

  it('no accessible project → an empty dashboard', async () => {
    const { ctrl } = make({ all: false, projectIds: [] });
    const out: any = await ctrl.getManagerDashboard({ id: 9, isAdmin: false });
    expect(out.projects).toEqual([]);
    expect(out.kpis.totalProjects).toBe(0);
  });
});
