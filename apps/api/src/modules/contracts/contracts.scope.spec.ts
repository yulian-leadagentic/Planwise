/**
 * Permissions round 4 (2026-11-23) — D-13: contracts, billings, expenses
 * and milestones are scoped by project. finance:read reaches every
 * project; anyone else needs the route permission AND project access.
 * Round-2 money stripping is unchanged.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { BillingsController } from './billings.controller';
import { BillingsService } from './billings.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ReportsController } from '../reports/reports.controller';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
/** Finance user, on no project. */
const FINANCE = {
  id: 3,
  isAdmin: false,
  roleModules: [perm('/contracts', { canRead: true }), perm('/finance', { canRead: true }), perm('/reports', { canRead: true })],
};
/** Contracts reader without finance, member of project 59 only. */
const MEMBER = {
  id: 4,
  isAdmin: false,
  roleModules: [perm('/contracts', { canRead: true, canWrite: true }), perm('/reports', { canRead: true })],
};
/** Contracts reader without finance, on no project. */
const STRANGER = { ...MEMBER, id: 9 };

function fakeAccess() {
  const projectsOf: Record<number, number[]> = { 4: [59] };
  return {
    assertProjectAccess: jest.fn(async (userId: number, projectId: number, isAdmin: boolean) => {
      if (isAdmin || (projectsOf[userId] ?? []).includes(projectId)) return;
      throw new PermissionDeniedException("You're not a member of this project.", { reason: 'NOT_PROJECT_MEMBER' });
    }),
    getAccessibleProjectIds: jest.fn(async (userId: number) => ({ all: false, projectIds: projectsOf[userId] ?? [] })),
  };
}

function contract() {
  return {
    id: 1,
    projectId: 59,
    name: 'Design',
    totalAmount: '100000.00',
    items: [{ id: 1, description: 'Phase A', quantity: '2.00', unitPrice: '100.00', total: '200.00' }],
    billings: [{ id: 2, amount: '50.00', status: 'draft' }],
  };
}

function makeContracts() {
  const contractsService: any = {
    findOne: jest.fn(async () => contract()),
    findAll: jest.fn(async () => ({ data: [], meta: { total: 0 } })),
    remove: jest.fn(async () => ({ message: 'Contract deleted' })),
    getExpenses: jest.fn(async () => [{ id: 9, amount: '10.00' }]),
    createExpense: jest.fn(async () => ({ id: 9 })),
    getContractProjectId: jest.fn(async () => 59),
    getItemProjectId: jest.fn(async () => 59),
    getLabelProjectId: jest.fn(async () => 59),
    getMilestoneProjectId: jest.fn(async () => 59),
    removeMilestone: jest.fn(async () => ({ message: 'Milestone deleted' })),
  };
  const access = fakeAccess();
  return { ctrl: new ContractsController(contractsService, access as any), contractsService, access };
}

describe('ContractsController — project scope (D-13)', () => {
  it('a finance:read holder reads a contract of a project he is not on, with the money', async () => {
    const { ctrl, access } = makeContracts();
    const out: any = await ctrl.findOne(FINANCE, 1);
    expect(out.totalAmount).toBe('100000.00');
    expect(access.assertProjectAccess).not.toHaveBeenCalled();
  });

  it('a project member without finance reads the contract, but still gets no money', async () => {
    const { ctrl } = makeContracts();
    const out: any = await ctrl.findOne(MEMBER, 1);
    expect(out.name).toBe('Design');
    expect(out).not.toHaveProperty('totalAmount');
    expect(out.items[0]).not.toHaveProperty('unitPrice');
    expect(out.billings[0]).not.toHaveProperty('amount');
  });

  it('a stranger without finance is denied the contract, its delete and its expenses', async () => {
    const { ctrl, contractsService } = makeContracts();
    await expect(ctrl.findOne(STRANGER, 1)).rejects.toMatchObject({ details: { reason: 'NOT_PROJECT_MEMBER' } });
    await expect(ctrl.remove(STRANGER, 1)).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(ctrl.getExpenses(STRANGER, 59)).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(
      ctrl.createExpense(STRANGER, { projectId: 59, expenseType: 'travel', date: '2026-11-23' } as any),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(ctrl.removeMilestone(STRANGER, 3)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(contractsService.findOne).not.toHaveBeenCalled();
    expect(contractsService.remove).not.toHaveBeenCalled();
    expect(contractsService.getExpenses).not.toHaveBeenCalled();
    expect(contractsService.createExpense).not.toHaveBeenCalled();
    expect(contractsService.removeMilestone).not.toHaveBeenCalled();
  });

  it('a contract with no project: finance:read only', async () => {
    const { ctrl, contractsService } = makeContracts();
    contractsService.getContractProjectId.mockResolvedValue(null);
    await expect(ctrl.findOne(MEMBER, 1)).rejects.toMatchObject({ details: { module: 'finance', action: 'read' } });
    await ctrl.findOne(FINANCE, 1);
  });

  it('the list: finance:read unscoped, anyone else limited to his projects', async () => {
    const { ctrl, contractsService } = makeContracts();
    await ctrl.findAll(FINANCE);
    expect(contractsService.findAll).toHaveBeenLastCalledWith(expect.anything(), null);
    await ctrl.findAll(MEMBER);
    expect(contractsService.findAll).toHaveBeenLastCalledWith(expect.anything(), [59]);
    await expect(ctrl.findAll(STRANGER, undefined, undefined, undefined, 59)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
  });
});

describe('BillingsController — project scope (D-13)', () => {
  function make() {
    const billingsService: any = {
      findOne: jest.fn(async () => ({ id: 1, amount: '500.00', status: 'draft' })),
      findAll: jest.fn(async () => []),
      getContractProjectId: jest.fn(async () => 59),
      getBillingProjectId: jest.fn(async () => 59),
    };
    return { ctrl: new BillingsController(billingsService, fakeAccess() as any), billingsService };
  }

  it('a stranger without finance is denied; a finance holder reads with the amount', async () => {
    const { ctrl, billingsService } = make();
    await expect(ctrl.findOne(STRANGER, 1)).rejects.toMatchObject({ details: { reason: 'NOT_PROJECT_MEMBER' } });
    expect(billingsService.findOne).not.toHaveBeenCalled();
    expect(((await ctrl.findOne(FINANCE, 1)) as any).amount).toBe('500.00');
    expect(await ctrl.findOne(MEMBER, 1)).not.toHaveProperty('amount');
  });

  it('the list is limited to the caller\'s projects without finance', async () => {
    const { ctrl, billingsService } = make();
    await ctrl.findAll(MEMBER);
    expect(billingsService.findAll).toHaveBeenLastCalledWith(expect.anything(), [59]);
    await ctrl.findAll(FINANCE);
    expect(billingsService.findAll).toHaveBeenLastCalledWith(expect.anything(), null);
  });
});

describe('GET /reports/milestones — per-project list (§1)', () => {
  function make() {
    const reportsService: any = { milestonesReport: jest.fn(async () => []) };
    return { ctrl: new ReportsController(reportsService, {} as any, fakeAccess() as any), reportsService };
  }

  it('scoped to accessible projects unless the caller holds finance:read', async () => {
    const { ctrl, reportsService } = make();
    await ctrl.milestones(MEMBER, {} as any);
    expect(reportsService.milestonesReport).toHaveBeenLastCalledWith({}, [59]);
    await ctrl.milestones(FINANCE, {} as any);
    expect(reportsService.milestonesReport).toHaveBeenLastCalledWith({}, null);
  });

  it('a projectId the caller cannot reach → 403', async () => {
    const { ctrl, reportsService } = make();
    await expect(ctrl.milestones(STRANGER, { projectId: 59 } as any)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(reportsService.milestonesReport).not.toHaveBeenCalled();
  });
});

// ─── Review fix: contract items stay in the contract's project ───────────

describe("ContractsService — item label / milestone in the contract's project", () => {
  /** Contract 1 → project 59, contract 2 → no project; item 10 is on contract 1. */
  function make() {
    const labels: Record<number, number> = { 5: 59, 6: 60 };
    const milestones: Record<number, number> = { 7: 5, 8: 6 }; // milestone → label
    const prisma: any = {
      contract: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 1 ? { projectId: 59 } : where.id === 2 ? { projectId: null } : null,
        ),
      },
      contractItem: {
        findUnique: jest.fn(async ({ where }: any) => (where.id === 10 ? { contract: { projectId: 59 } } : null)),
        create: jest.fn(async ({ data }: any) => ({ id: 11, ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
      label: {
        findFirst: jest.fn(async ({ where }: any) =>
          labels[where.id] != null ? { projectId: labels[where.id] } : null,
        ),
      },
      labelMilestone: {
        findUnique: jest.fn(async ({ where }: any) =>
          milestones[where.id] != null ? { label: { projectId: labels[milestones[where.id]] } } : null,
        ),
      },
    };
    return { svc: new ContractsService(prisma, { write: jest.fn() } as any), prisma };
  }
  const code = (e: any) => (e instanceof BadRequestException ? (e.getResponse() as any).code : e);

  it('addItem: a label of another project → 400 CROSS_PROJECT_PLACEMENT, nothing written', async () => {
    const { svc, prisma } = make();
    const err = await svc.addItem(1, { labelId: 6, unitPrice: 1 }).catch((e) => e);
    expect(code(err)).toBe('CROSS_PROJECT_PLACEMENT');
    expect(prisma.contractItem.create).not.toHaveBeenCalled();
  });

  it('addItem: a milestone whose label is in another project → CROSS_PROJECT_PLACEMENT', async () => {
    const { svc, prisma } = make();
    const err = await svc.addItem(1, { labelId: 5, milestoneId: 8, unitPrice: 1 }).catch((e) => e);
    expect(code(err)).toBe('CROSS_PROJECT_PLACEMENT');
    expect(prisma.contractItem.create).not.toHaveBeenCalled();
  });

  it("addItem: label and milestone of the contract's project are accepted; none at all needs no lookup", async () => {
    const { svc, prisma } = make();
    await svc.addItem(1, { labelId: 5, milestoneId: 7, unitPrice: 1 });
    expect(prisma.contractItem.create).toHaveBeenCalledTimes(1);
    prisma.label.findFirst.mockClear();
    await svc.addItem(1, { description: 'x', unitPrice: 1 });
    expect(prisma.label.findFirst).not.toHaveBeenCalled();
    expect(prisma.contractItem.create).toHaveBeenCalledTimes(2);
  });

  it('addItem: a contract without a project cannot take a project label', async () => {
    const { svc } = make();
    const err = await svc.addItem(2, { labelId: 5, unitPrice: 1 }).catch((e) => e);
    expect(code(err)).toBe('CROSS_PROJECT_PLACEMENT');
  });

  it('a label that does not exist → 404', async () => {
    const { svc } = make();
    await expect(svc.addItem(1, { labelId: 99, unitPrice: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updateItem: moving the item to a label or milestone of another project → CROSS_PROJECT_PLACEMENT', async () => {
    const { svc, prisma } = make();
    expect(code(await svc.updateItem(10, { labelId: 6 }).catch((e) => e))).toBe('CROSS_PROJECT_PLACEMENT');
    expect(code(await svc.updateItem(10, { milestoneId: 8 }).catch((e) => e))).toBe('CROSS_PROJECT_PLACEMENT');
    expect(prisma.contractItem.update).not.toHaveBeenCalled();
    await svc.updateItem(10, { labelId: 5, milestoneId: 7 });
    await svc.updateItem(10, { description: 'renamed' });
    expect(prisma.contractItem.update).toHaveBeenCalledTimes(2);
  });
});

describe('BillingsService.update — the contract cannot be changed', () => {
  it('ignores a contractId in the body (a billing cannot move to another contract or project)', async () => {
    const prisma: any = {
      billing: {
        findUnique: jest.fn(async () => ({ id: 1, contractId: 1 })),
        update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      },
    };
    const svc = new BillingsService(prisma);
    await svc.update(1, { contractId: 2, description: 'x' });
    expect(prisma.billing.update.mock.calls[0][0].data).not.toHaveProperty('contractId');
  });
});
