/**
 * DP · empty-ZDT prevention (2026-11-03) — unit tests for the
 * `setTarget` / `batchSetTargets` short-circuit that stops ghost
 * ZoneDeliverableTarget rows from being written.
 *
 * Context: before this fix, saving the Deliverable Planning grid
 * upserted a ZDT for every (zone × deliverable) cell including the
 * "no target" ones, producing all-null rows that the FE scoping then
 * counted as a connection and emitted the deliverable under every
 * zone (project 40 regression).
 *
 * These tests exercise the write-path with a jest-mocked Prisma — no
 * DB needed. They assert the three cases the work order calls out:
 *   (a) empty save + no existing row → no row created
 *   (b) empty save + existing row    → row deleted
 *   (c) real target                  → row persisted correctly
 * Plus a 4th guard that a persisted duration preserves the row (the
 * tri-state `durationWeeks: undefined = keep` contract).
 */
import { ProjectDeliverablesService } from './project-deliverables.service';

type MockPrisma = {
  zoneDeliverableTarget: {
    upsert: jest.Mock;
    deleteMany: jest.Mock;
    findUnique: jest.Mock;
  };
  projectDeliverable: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

function makeService(): { service: ProjectDeliverablesService; prisma: MockPrisma } {
  const prisma: MockPrisma = {
    zoneDeliverableTarget: {
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    projectDeliverable: {
      findUnique: jest.fn().mockResolvedValue({ id: 1 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    },
  };
  const activityLog = { write: jest.fn() } as any;
  const service = new ProjectDeliverablesService(prisma as any, activityLog);
  return { service, prisma };
}

describe('ProjectDeliverablesService.setTarget — empty-ZDT prevention', () => {
  it('(a) empty save + no existing row → does NOT create a ZDT', async () => {
    const { service, prisma } = makeService();
    prisma.zoneDeliverableTarget.findUnique.mockResolvedValueOnce(null);

    await service.setTarget(
      /* id */ 10,
      /* months */ null,
      /* baseDate */ undefined,
      /* zoneId */ 7,
      /* durationWeeks */ undefined,
    );

    expect(prisma.zoneDeliverableTarget.upsert).not.toHaveBeenCalled();
    // deleteMany with the composite WHERE is safe — matches zero rows
    // when none exist and the ghost row is never created.
    expect(prisma.zoneDeliverableTarget.deleteMany).toHaveBeenCalledWith({
      where: { zoneId: 7, projectDeliverableId: 10 },
    });
  });

  it('(b) empty save + existing row → DELETES the row', async () => {
    const { service, prisma } = makeService();
    // Existing row carries no duration either → full clear.
    prisma.zoneDeliverableTarget.findUnique.mockResolvedValueOnce({ estimatedDurationWeeks: null });

    await service.setTarget(
      /* id */ 11,
      /* months */ null,
      /* baseDate */ undefined,
      /* zoneId */ 8,
      /* durationWeeks */ null, // explicit clear
    );

    expect(prisma.zoneDeliverableTarget.upsert).not.toHaveBeenCalled();
    expect(prisma.zoneDeliverableTarget.deleteMany).toHaveBeenCalledWith({
      where: { zoneId: 8, projectDeliverableId: 11 },
    });
  });

  it('(c) real target → persists via upsert, no delete', async () => {
    const { service, prisma } = makeService();

    await service.setTarget(
      /* id */ 12,
      /* months */ 2,
      /* baseDate */ '2026-01-01',
      /* zoneId */ 9,
      /* durationWeeks */ 3,
    );

    expect(prisma.zoneDeliverableTarget.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.zoneDeliverableTarget.deleteMany).not.toHaveBeenCalled();

    const args = prisma.zoneDeliverableTarget.upsert.mock.calls[0][0];
    expect(args.create.targetMonths).toBe(2);
    expect(args.create.estimatedDurationWeeks).toBe(3);
    expect(args.create.targetDate).toBeInstanceOf(Date);
    // computeTarget snaps Jan 1 2026 (Thursday) + 2mo = Mar 1 2026
    // (Sunday); 1-Mar is a Sunday so stays. YYYY-MM-DD prefix check.
    expect((args.create.targetDate as Date).toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('(d) months cleared but persisted duration survives → upsert, NOT delete', async () => {
    const { service, prisma } = makeService();
    // Existing row carries a duration — tri-state `undefined = keep`
    // means the resulting row is still non-empty, so the fix must
    // preserve it via upsert (clearing only targetDate+targetMonths).
    prisma.zoneDeliverableTarget.findUnique.mockResolvedValueOnce({ estimatedDurationWeeks: 4 });

    await service.setTarget(
      /* id */ 13,
      /* months */ null,
      /* baseDate */ undefined,
      /* zoneId */ 10,
      /* durationWeeks */ undefined, // keep existing
    );

    expect(prisma.zoneDeliverableTarget.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.zoneDeliverableTarget.deleteMany).not.toHaveBeenCalled();

    const args = prisma.zoneDeliverableTarget.upsert.mock.calls[0][0];
    expect(args.update.targetDate).toBeNull();
    expect(args.update.targetMonths).toBeNull();
    // durPatch is {} when durationWeeks is undefined — the key is
    // absent from the write, so Prisma leaves the column untouched.
    expect('estimatedDurationWeeks' in args.update).toBe(false);
    expect('estimatedDurationWeeks' in args.create).toBe(false);
  });
});
