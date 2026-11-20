/**
 * Permissions round 2 (2026-11-20) — central read-side money redaction.
 *
 * `finance:read` is the only thing that lets a caller see a money value.
 * The global FinanceRedactionInterceptor removes the unambiguous money
 * keys (FINANCE_REDACTED_KEYS) at any depth, plus the parent-scoped ones
 * (`project.budget`, `milestones[].amount`, …), from every JSON response
 * of a caller without it — and leaves hours, pagination totals and HR
 * day/hour `amount`s alone.
 */
import { of, lastValueFrom } from 'rxjs';
import { Prisma } from '@prisma/client';
import { StreamableFile } from '@nestjs/common';

import { FinanceRedactionInterceptor } from './finance-redaction.interceptor';
import { ResponseInterceptor } from './response.interceptor';
import { FINANCE_REDACTED_KEYS, redactFinanceFields } from '../finance/finance-access';

const perm = (route: string, flags: Record<string, boolean>) => ({
  module: { route, name: route.replace(/^\//, '') },
  canRead: false,
  canWrite: false,
  canDelete: false,
  canApprove: false,
  canExport: false,
  ...flags,
});

const FINANCE_READER = { id: 1, isAdmin: false, roleModules: [perm('/finance', { canRead: true })] };
const EMPLOYEE = { id: 2, isAdmin: false, roleModules: [perm('/projects', { canRead: true }), perm('/tasks', { canRead: true })] };
// Admin is NOT a finance reader: finance is in NO_ADMIN_BYPASS.
const ADMIN_NO_FINANCE = { id: 3, isAdmin: true, roleModules: [perm('/admin', { canRead: true, canWrite: true })] };

function ctx(user: any, type: 'http' | 'ws' = 'http') {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

async function run(user: any, payload: unknown, type: 'http' | 'ws' = 'http') {
  const interceptor = new FinanceRedactionInterceptor();
  return lastValueFrom(interceptor.intercept(ctx(user, type), { handle: () => of(payload) }));
}

/** The user list row `GET /users` returns (users.service findAll). */
function usersListPayload() {
  return {
    data: [
      {
        id: 7,
        firstName: 'Dana',
        userType: 'employee',
        dailyStandardHours: '8.40',
        seniorityLevelId: 2,
        seniorityLevel: { id: 2, code: 'SR', name: 'Senior', defaultHourlyCost: new Prisma.Decimal('210.50'), currency: 'ILS' },
        roleName: 'Employee',
        effectiveHourlyCost: 240,
        rateSource: 'override',
      },
    ],
    meta: { total: 1, page: 1, perPage: 20, totalPages: 1 },
  };
}

/** A `GET /tasks` row (list) and `GET /tasks/:id` (detail, full project row). */
function taskPayload() {
  return {
    id: 11,
    name: 'Model level 2',
    budgetHours: new Prisma.Decimal('16.00'),
    budgetAmount: new Prisma.Decimal('4800.00'),
    loggedMinutes: 600,
    project: { id: 59, name: 'Tower A', budget: new Prisma.Decimal('900000.00'), estimatedValue: new Prisma.Decimal('1000000.00') },
    assignees: [{ userId: 7, role: 'Modeler', hourlyRate: new Prisma.Decimal('120.00'), user: { id: 7, firstName: 'Dana' } }],
    comments: [],
  };
}

describe('FinanceRedactionInterceptor', () => {
  it('strips money keys deep in arrays / nested objects for a caller without finance:read', async () => {
    const out: any = await run(EMPLOYEE, { data: [taskPayload()], meta: { total: 1 } });
    const t = out.data[0];
    expect(t.budgetAmount).toBeUndefined();
    expect(t.assignees[0].hourlyRate).toBeUndefined();
    expect(t.project.estimatedValue).toBeUndefined();
    // project.budget — parent-scoped key
    expect(t.project.budget).toBeUndefined();
    // hours / non-money stay
    expect(t.budgetHours).toBeInstanceOf(Prisma.Decimal);
    expect(t.loggedMinutes).toBe(600);
    expect(t.project.name).toBe('Tower A');
    expect(t.assignees[0].user).toEqual({ id: 7, firstName: 'Dana' });
    expect(out.meta).toEqual({ total: 1 });
  });

  it('keeps every value for a finance:read caller (same reference, no walk)', async () => {
    const payload = { data: [taskPayload()] };
    const out: any = await run(FINANCE_READER, payload);
    expect(out).toBe(payload);
    expect(out.data[0].budgetAmount.toString()).toBe('4800');
    expect(out.data[0].project.budget.toString()).toBe('900000');
  });

  it('an Admin without the explicit finance grant is redacted (no admin bypass)', async () => {
    const out: any = await run(ADMIN_NO_FINANCE, taskPayload());
    expect(out.budgetAmount).toBeUndefined();
    expect(out.project.budget).toBeUndefined();
  });

  it('no user (public route) → redacted', async () => {
    const out: any = await run(undefined, { estimatedValue: 5, name: 'x' });
    expect(out).toEqual({ name: 'x' });
  });

  it('GET /users — level cost, effective cost and rateSource are gone; the level name stays', async () => {
    const out: any = await run(EMPLOYEE, usersListPayload());
    const u = out.data[0];
    expect(u).not.toHaveProperty('effectiveHourlyCost');
    expect(u).not.toHaveProperty('rateSource');
    expect(u.seniorityLevel).toEqual({ id: 2, code: 'SR', name: 'Senior', currency: 'ILS' });
    expect(u.dailyStandardHours).toBe('8.40');
    expect(out.meta.total).toBe(1);
  });

  it('runs on the final wrapped payload (outside ResponseInterceptor)', async () => {
    const response = new ResponseInterceptor();
    const finance = new FinanceRedactionInterceptor();
    const inner = { handle: () => response.intercept(ctx(EMPLOYEE), { handle: () => of(taskPayload()) }) };
    const out: any = await lastValueFrom(finance.intercept(ctx(EMPLOYEE), inner));
    expect(out.success).toBe(true);
    expect(out.data.budgetAmount).toBeUndefined();
    expect(out.data.name).toBe('Model level 2');
  });

  it('leaves HR / time / attendance `amount`, pagination `total` and hours untouched', async () => {
    const payload = {
      absences: [{ id: 1, amount: new Prisma.Decimal('1.50'), unit: 'days' }],
      buckets: [{ dailyAmount: '2.00', maxPerYear: '10.00' }],
      summary: { total: 42, created: 40 },
      meta: { total: 3, page: 1 },
      monthly: { actualHours: '160.00', deviation: '-4.00' },
    };
    const out = await run(EMPLOYEE, payload);
    expect(out).toBe(payload); // nothing to strip → same reference
  });

  it('skips Buffers, Dates, Decimals and StreamableFile (only plain objects / arrays are walked)', async () => {
    const buf = Buffer.from('budgetAmount');
    const date = new Date('2026-11-20T00:00:00Z');
    const dec = new Prisma.Decimal('12.30');
    const file = new StreamableFile(Buffer.from('x'));
    expect(await run(EMPLOYEE, buf)).toBe(buf);
    expect(await run(EMPLOYEE, file)).toBe(file);
    const out: any = await run(EMPLOYEE, { when: date, hours: dec, file: buf, totalCost: dec });
    expect(out.when).toBe(date);
    expect(out.hours).toBe(dec);
    expect(out.file).toBe(buf);
    expect(out).not.toHaveProperty('totalCost');
  });

  it('handles cycles and shared sub-trees without looping; a shared node is redacted everywhere', async () => {
    const shared: any = { id: 1, hourlyRate: 100 };
    const root: any = { a: shared, b: [shared], name: 'r' };
    root.self = root; // cycle
    const out: any = redactFinanceFields(root);
    expect(out.a).toEqual({ id: 1 });
    expect(out.b[0]).toBe(out.a);
    expect(out.name).toBe('r');
    // input never mutated
    expect(shared.hourlyRate).toBe(100);
  });

  it('never mutates the input (service caches stay intact for the next finance caller)', async () => {
    const payload = taskPayload();
    const snapshot = JSON.stringify(payload);
    await run(EMPLOYEE, payload);
    expect(JSON.stringify(payload)).toBe(snapshot);
  });

  it('keeps boolean values under a money key (UI column-visibility preferences)', async () => {
    const pref = { key: 'tasks.columns', value: { budgetAmount: true, name: true, actualCost: false } };
    expect(await run(EMPLOYEE, pref)).toBe(pref);
  });

  it('scoped keys: billings[].amount / milestones[].amount / expenses[].amount; `amount` elsewhere stays', async () => {
    const out: any = await run(EMPLOYEE, {
      billings: [{ id: 1, amount: '500.00', status: 'draft' }],
      milestones: [{ id: 2, name: 'M1', amount: '1000.00' }],
      milestone: { id: 3, amount: '7' },
      expenses: [{ id: 4, amount: '12' }],
      absence: { amount: '1.00' },
    });
    expect(out.billings[0]).toEqual({ id: 1, status: 'draft' });
    expect(out.milestones[0]).toEqual({ id: 2, name: 'M1' });
    expect(out.milestone).toEqual({ id: 3 });
    expect(out.expenses[0]).toEqual({ id: 4 });
    expect(out.absence).toEqual({ amount: '1.00' });
  });

  it('every listed key is stripped (activity-log changes, data-import before/after JSON)', async () => {
    const row: Record<string, unknown> = { id: 1 };
    for (const k of FINANCE_REDACTED_KEYS) row[k] = 1;
    const out: any = await run(EMPLOYEE, { logs: [{ changes: row }] });
    expect(out.logs[0].changes).toEqual({ id: 1 });
  });

  it('non-HTTP contexts pass through untouched', async () => {
    const payload = { budgetAmount: 1 };
    expect(await run(EMPLOYEE, payload, 'ws')).toBe(payload);
  });
});
