/**
 * Permissions round 2 (2026-11-20) — contract money (B-05 / B-12 / B-13).
 *
 *   Read:  ContractItem `total` / `quantity` / `unitPrice`, Billing /
 *          LabelMilestone / Expense `amount` and Contract `totalAmount`
 *          are stripped for callers without finance:read.
 *   Write: changing any of them needs finance:write; moving a billing's
 *          status (approval) needs finance:approve. Unchanged echoes pass.
 *   Terms: `GET /contracts/terms/:userId` and `POST /contracts/terms`
 *          (monthly salary / hourly rate for any user, behind plain
 *          contracts:*) are removed — nothing in the web called them.
 */
import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { BillingsController } from './billings.controller';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const CONTRACTS_WRITER = { id: 4, isAdmin: false, roleModules: [perm('/contracts', { canRead: true, canWrite: true })] };
const FINANCE_WRITER = {
  id: 5,
  isAdmin: false,
  roleModules: [perm('/contracts', { canRead: true, canWrite: true }), perm('/finance', { canRead: true, canWrite: true })],
};
const FINANCE_APPROVER = {
  id: 6,
  isAdmin: false,
  roleModules: [perm('/contracts', { canRead: true, canWrite: true }), perm('/finance', { canRead: true, canApprove: true })],
};

describe('billings (B-12 / B-13)', () => {
  const stored = { id: 1, amount: '500.00', status: 'draft', description: 'x' };
  function make() {
    const billingsService: any = {
      findAll: jest.fn(async () => [{ ...stored }]),
      findOne: jest.fn(async () => ({ ...stored })),
      create: jest.fn(async () => ({ ...stored })),
      update: jest.fn(async () => ({ ...stored })),
    };
    return { ctrl: new BillingsController(billingsService), billingsService };
  }

  it('reads drop the amount without finance:read', async () => {
    const { ctrl } = make();
    expect(await ctrl.findAll(CONTRACTS_WRITER)).toEqual([{ id: 1, status: 'draft', description: 'x' }]);
    expect(await ctrl.findOne(CONTRACTS_WRITER, 1)).toEqual({ id: 1, status: 'draft', description: 'x' });
    expect((await ctrl.findOne(FINANCE_WRITER, 1) as any).amount).toBe('500.00');
  });

  it('a changed amount needs finance:write', async () => {
    const { ctrl, billingsService } = make();
    await expect(ctrl.update(CONTRACTS_WRITER, 1, { amount: 900 })).rejects.toThrow(/You can't change amounts — that needs permission to change financial data/);
    expect(billingsService.update).not.toHaveBeenCalled();
    await ctrl.update(FINANCE_WRITER, 1, { amount: 900 });
    expect(billingsService.update).toHaveBeenCalled();
  });

  it('a status change needs finance:approve — finance:write is not enough', async () => {
    const { ctrl, billingsService } = make();
    await expect(ctrl.update(FINANCE_WRITER, 1, { status: 'approved' })).rejects.toThrow(/You can't change the billing status — that needs permission to approve billings/);
    await expect(ctrl.update(CONTRACTS_WRITER, 1, { status: 'approved' })).rejects.toThrow(ForbiddenException);
    expect(billingsService.update).not.toHaveBeenCalled();
    await ctrl.update(FINANCE_APPROVER, 1, { status: 'approved' });
    expect(billingsService.update).toHaveBeenCalled();
  });

  it('an unchanged whole-object echo passes for anyone with contracts:write', async () => {
    const { ctrl, billingsService } = make();
    await ctrl.update(CONTRACTS_WRITER, 1, { amount: '500', status: 'draft', description: 'new text' });
    expect(billingsService.update).toHaveBeenCalled();
  });

  it('create: an amount needs finance:write, a non-draft status needs finance:approve', async () => {
    const { ctrl, billingsService } = make();
    const dto: any = { contractId: 1, type: 'invoice', amount: 100, billingDate: '2026-11-20' };
    await expect(ctrl.create(CONTRACTS_WRITER, dto)).rejects.toThrow(/You can't change amounts — that needs permission to change financial data/);
    await expect(ctrl.create(FINANCE_WRITER, { ...dto, status: 'approved' })).rejects.toThrow(/permission to approve billings/);
    await ctrl.create(FINANCE_WRITER, { ...dto, status: 'draft' });
    expect(billingsService.create).toHaveBeenCalledTimes(1);
  });
});

describe('contracts (B-12 / B-13)', () => {
  function make() {
    const contractsService: any = {
      findOne: jest.fn(async () => ({
        id: 1,
        name: 'Design',
        totalAmount: '100000.00',
        items: [{ id: 1, description: 'Phase A', quantity: '2.00', unitPrice: '100.00', total: '200.00' }],
        billings: [{ id: 2, amount: '50.00', status: 'draft' }],
      })),
      update: jest.fn(async () => ({ id: 1 })),
      getItem: jest.fn(async () => ({ id: 1, quantity: '2.00', unitPrice: '100.00', total: '200.00' })),
      updateItem: jest.fn(async () => ({ id: 1, description: 'x', quantity: '2.00', unitPrice: '100.00', total: '200.00' })),
      addItem: jest.fn(async () => ({ id: 1 })),
      getMilestone: jest.fn(async () => ({ id: 3, amount: null })),
      updateMilestone: jest.fn(async () => ({ id: 3, name: 'M', amount: null })),
      createExpense: jest.fn(async () => ({ id: 9, amount: '10.00' })),
      getExpenses: jest.fn(async () => [{ id: 9, amount: '10.00', expenseType: 'travel' }]),
    };
    return { ctrl: new ContractsController(contractsService), contractsService };
  }

  it('GET /contracts/:id drops totalAmount, item total / quantity / unitPrice and billing amounts', async () => {
    const { ctrl } = make();
    const out: any = await ctrl.findOne(CONTRACTS_WRITER, 1);
    expect(out).not.toHaveProperty('totalAmount');
    expect(out.items[0]).toEqual({ id: 1, description: 'Phase A' });
    expect(out.billings[0]).toEqual({ id: 2, status: 'draft' });
    const full: any = await ctrl.findOne(FINANCE_WRITER, 1);
    expect(full.items[0].total).toBe('200.00');
  });

  it('PATCH /contracts/:id — a changed totalAmount needs finance:write; an echo passes', async () => {
    const { ctrl, contractsService } = make();
    await expect(ctrl.update(CONTRACTS_WRITER, 1, { totalAmount: 1 })).rejects.toThrow(ForbiddenException);
    await ctrl.update(CONTRACTS_WRITER, 1, { totalAmount: 100000, notes: 'n' } as any);
    expect(contractsService.update).toHaveBeenCalledTimes(1);
  });

  it('items: a changed quantity / price needs finance:write; the echo drops item money', async () => {
    const { ctrl, contractsService } = make();
    await expect(ctrl.updateItem(CONTRACTS_WRITER, 1, { quantity: 3 })).rejects.toThrow(/You can't change quantities — that needs permission to change financial data/);
    const out: any = await ctrl.updateItem(CONTRACTS_WRITER, 1, { description: 'x', quantity: 2, unitPrice: 100 });
    expect(out).toEqual({ id: 1, description: 'x' });
    // a new item always carries a unit price → finance:write
    await expect(ctrl.addItem(CONTRACTS_WRITER, 1, { description: 'y', unitPrice: 5 })).rejects.toThrow(ForbiddenException);
    expect(contractsService.addItem).not.toHaveBeenCalled();
  });

  it('milestones / expenses: setting an amount needs finance:write; reads drop it', async () => {
    const { ctrl, contractsService } = make();
    await expect(ctrl.updateMilestone(CONTRACTS_WRITER, 3, { amount: 1000 })).rejects.toThrow(ForbiddenException);
    const m: any = await ctrl.updateMilestone(CONTRACTS_WRITER, 3, { name: 'M' });
    expect(m).toEqual({ id: 3, name: 'M' });
    await expect(ctrl.createExpense(CONTRACTS_WRITER, { projectId: 1, amount: 10 } as any)).rejects.toThrow(ForbiddenException);
    expect(contractsService.createExpense).not.toHaveBeenCalled();
    expect(await ctrl.getExpenses(CONTRACTS_WRITER, 1)).toEqual([{ id: 9, expenseType: 'travel' }]);
  });

  it('the terms routes and service methods are gone (B-05 / B-14)', () => {
    const proto = ContractsController.prototype as any;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== 'constructor')
      .map((k) => Reflect.getMetadata(PATH_METADATA, proto[k]))
      .filter(Boolean);
    expect(paths).not.toContain('terms');
    expect(paths).not.toContain('terms/:userId');
    expect((ContractsService.prototype as any).createTerm).toBeUndefined();
    expect((ContractsService.prototype as any).getTerms).toBeUndefined();
  });
});
