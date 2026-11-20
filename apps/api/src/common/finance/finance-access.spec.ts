/**
 * Permissions round 2 (2026-11-20) — the shared finance helpers.
 *
 *   • canSeeFinance / canWriteFinance / canApproveFinance read the
 *     explicit finance grant — no Admin shortcut (NO_ADMIN_BYPASS).
 *   • assertFinanceFieldWrites: a money key sent with a value different
 *     from the stored one (or non-empty on create) without finance:write
 *     → 403 naming the field; an unchanged echo passes (forms send whole
 *     objects); billing status needs finance:approve.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PermissionDeniedException } from '../errors/permission-denied';
import {
  assertFinanceAccess,
  assertFinanceFieldWrites,
  canApproveFinance,
  canSeeFinance,
  canWriteFinance,
  findFinanceFieldChanges,
  omitKeys,
} from './finance-access';

const finance = (flags: Record<string, boolean>) => ({
  id: 1,
  isAdmin: false,
  roleModules: [{ module: { route: '/finance', name: 'Finance' }, ...flags }],
});
const READER = finance({ canRead: true });
const WRITER = finance({ canRead: true, canWrite: true });
const APPROVER = finance({ canRead: true, canApprove: true });
const ADMIN = { id: 9, isAdmin: true, roleModules: [{ module: { route: '/admin', name: 'Admin' }, canRead: true, canWrite: true }] };

describe('finance grants', () => {
  it('read / write / approve each need their own flag', () => {
    expect(canSeeFinance(READER)).toBe(true);
    expect(canWriteFinance(READER)).toBe(false);
    expect(canWriteFinance(WRITER)).toBe(true);
    expect(canApproveFinance(WRITER)).toBe(false);
    expect(canApproveFinance(APPROVER)).toBe(true);
  });

  it('an Admin without the explicit grant has none of them', () => {
    expect(canSeeFinance(ADMIN)).toBe(false);
    expect(canWriteFinance(ADMIN)).toBe(false);
    expect(canApproveFinance(ADMIN)).toBe(false);
    expect(() => assertFinanceAccess(ADMIN, 'read')).toThrow(ForbiddenException);
    expect(() => assertFinanceAccess(ADMIN, 'read')).toThrow(
      "You don't have permission to view financial data. Ask your administrator for access.",
    );
  });

  it('no user → nothing', () => {
    expect(canSeeFinance(undefined)).toBe(false);
    expect(canSeeFinance(null)).toBe(false);
  });
});

describe('omitKeys', () => {
  it('shallow-omits from one object or each object of an array, without mutating', () => {
    const row = { id: 1, total: 5, quantity: 2, description: 'x' };
    expect(omitKeys(row, ['total', 'quantity'])).toEqual({ id: 1, description: 'x' });
    expect(omitKeys([row], ['total'])).toEqual([{ id: 1, quantity: 2, description: 'x' }]);
    expect(row.total).toBe(5);
    expect(omitKeys(null, ['x'])).toBeNull();
  });
});

describe('findFinanceFieldChanges', () => {
  it('compares numerically across Decimal / string / number', () => {
    const stored = { budgetAmount: new Prisma.Decimal('1200.00') };
    expect(findFinanceFieldChanges({ budgetAmount: 1200 }, stored, ['budgetAmount'])).toEqual([]);
    expect(findFinanceFieldChanges({ budgetAmount: '1200.00' }, stored, ['budgetAmount'])).toEqual([]);
    expect(findFinanceFieldChanges({ budgetAmount: 1200.5 }, stored, ['budgetAmount'])).toEqual(['budgetAmount']);
  });

  it('null / undefined / "" are the same "no value"; an absent key is never a change', () => {
    expect(findFinanceFieldChanges({ budgetAmount: null }, { budgetAmount: null }, ['budgetAmount'])).toEqual([]);
    expect(findFinanceFieldChanges({ budgetAmount: '' }, { budgetAmount: null }, ['budgetAmount'])).toEqual([]);
    expect(findFinanceFieldChanges({ name: 'x' }, { budgetAmount: 5 }, ['budgetAmount'])).toEqual([]);
    expect(findFinanceFieldChanges({ budgetAmount: undefined }, { budgetAmount: 5 }, ['budgetAmount'])).toEqual([]);
    // clearing a stored value IS a change
    expect(findFinanceFieldChanges({ budgetAmount: null }, { budgetAmount: 5 }, ['budgetAmount'])).toEqual(['budgetAmount']);
  });

  it('create (no stored row): any non-empty value is a change', () => {
    expect(findFinanceFieldChanges({ budgetAmount: 0 }, null, ['budgetAmount'])).toEqual(['budgetAmount']);
    expect(findFinanceFieldChanges({ budgetAmount: null }, null, ['budgetAmount'])).toEqual([]);
  });
});

describe('assertFinanceFieldWrites', () => {
  const EMPLOYEE = { id: 2, isAdmin: false, roleModules: [{ module: { route: '/tasks' }, canRead: true, canWrite: true }] };

  it('403 naming the field in plain words when a money value changes without finance:write', async () => {
    const err = await assertFinanceFieldWrites(EMPLOYEE, { budgetAmount: 900 }, ['budgetAmount'], {
      budgetAmount: '500.00',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(err.message).toBe(
      "You can't change budget amounts — that needs permission to change financial data. Ask your administrator.",
    );
    expect(err.getResponse()).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { module: 'finance', action: 'write', field: 'budgetAmount' },
    });
  });

  it('several changed fields are listed together; no raw keys or permission names in the text', async () => {
    const err = await assertFinanceFieldWrites(
      EMPLOYEE,
      { salaryHourly: 90, seniorityLevelId: 3 },
      ['salaryHourly', 'seniorityLevelId'],
      null,
    ).catch((e) => e);
    expect(err.message).toBe(
      "You can't change salary rates and the labor category — that needs permission to change financial data. Ask your administrator.",
    );
    expect(err.message).not.toMatch(/salaryHourly|seniorityLevelId|finance:/);
    expect(err.getResponse().details).toEqual({
      module: 'finance',
      action: 'write',
      field: 'salaryHourly',
      fields: ['salaryHourly', 'seniorityLevelId'],
    });
  });

  it('an unchanged echo passes (whole-object forms)', async () => {
    await expect(
      assertFinanceFieldWrites(EMPLOYEE, { name: 'x', budgetAmount: '500.00' }, ['budgetAmount'], { budgetAmount: 500 }),
    ).resolves.toBeUndefined();
  });

  it('non-empty money on create → 403; empty passes', async () => {
    await expect(assertFinanceFieldWrites(EMPLOYEE, { budgetAmount: 10 }, ['budgetAmount'], null)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(assertFinanceFieldWrites(EMPLOYEE, { budgetAmount: null }, ['budgetAmount'], null)).resolves.toBeUndefined();
  });

  it('finance:write passes without even loading the stored row', async () => {
    const loader = jest.fn(async () => ({ budgetAmount: 1 }));
    await assertFinanceFieldWrites(WRITER, { budgetAmount: 99 }, ['budgetAmount'], loader);
    expect(loader).not.toHaveBeenCalled();
  });

  it('the loader only runs when a money key was actually sent', async () => {
    const loader = jest.fn(async () => ({ budgetAmount: 1 }));
    await assertFinanceFieldWrites(EMPLOYEE, { name: 'only a name' }, ['budgetAmount'], loader);
    expect(loader).not.toHaveBeenCalled();
    await expect(assertFinanceFieldWrites(EMPLOYEE, { budgetAmount: 2 }, ['budgetAmount'], loader)).rejects.toThrow();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('billing status needs finance:approve — finance:write is not enough', async () => {
    await expect(
      assertFinanceFieldWrites(WRITER, { status: 'approved' }, ['status'], { status: 'draft' }, 'approve'),
    ).rejects.toThrow(
      "You can't change the billing status — that needs permission to approve billings. Ask your administrator.",
    );
    await expect(
      assertFinanceFieldWrites(APPROVER, { status: 'approved' }, ['status'], { status: 'draft' }, 'approve'),
    ).resolves.toBeUndefined();
    // same status echoed back → no approval needed
    await expect(
      assertFinanceFieldWrites(EMPLOYEE, { status: 'draft' }, ['status'], { status: 'draft' }, 'approve'),
    ).resolves.toBeUndefined();
  });

  it('an Admin without finance:write is refused', async () => {
    await expect(
      assertFinanceFieldWrites(ADMIN, { estimatedValue: 1 }, ['estimatedValue'], { estimatedValue: null }),
    ).rejects.toThrow(ForbiddenException);
  });
});
