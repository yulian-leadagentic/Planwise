/**
 * Permissions round 2 (2026-11-20) — project money.
 *
 *   • B-10: `GET /projects/:id/tasks/export` now checks project access
 *     (any projects:read holder could export any project by id) and the
 *     workbook has no "Amount (₪)" column for callers without
 *     finance:read (files bypass the response interceptor).
 *   • B-13 / B-15: `POST` / `PATCH /projects/:id` — a changed budget /
 *     estimated value needs finance:write (an unchanged echo passes),
 *     and the echoed row drops project money for non-finance callers.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const PM = { id: 4, isAdmin: false, roleModules: [perm('/projects', { canRead: true, canWrite: true })] };
const FINANCE_PM = {
  id: 5,
  isAdmin: false,
  roleModules: [perm('/projects', { canRead: true, canWrite: true }), perm('/finance', { canRead: true, canWrite: true })],
};
// Admin is bypassed on projects but NOT on finance.
const ADMIN = { id: 1, isAdmin: true, roleModules: [] as any[] };

function makeExportService() {
  const prisma: any = {
    project: { findUnique: jest.fn(async () => ({ id: 59, name: 'Tower A', number: '1001' })) },
    task: {
      findMany: jest.fn(async () => [
        {
          code: 'T-1',
          name: 'Model L2',
          isPersonal: false,
          zone: null,
          phase: null,
          serviceType: null,
          deliverableTemplate: null,
          status: 'in_progress',
          priority: 'medium',
          requiresReview: true,
          budgetHours: new Prisma.Decimal('16'),
          budgetAmount: new Prisma.Decimal('48765'),
          startDate: null,
          endDate: null,
          completionPct: 10,
          assignees: [],
          description: '',
        },
      ]),
    },
  };
  const svc = new ProjectsService(prisma, {} as any, {} as any, {} as any, {} as any);
  jest.spyOn(svc, 'findOne').mockResolvedValue({ id: 59 } as any);
  return svc;
}

async function sheetText(buffer: Buffer): Promise<{ headers: string[]; text: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.getWorksheet('Tasks')!;
  const headers = (ws.getRow(1).values as any[]).filter(Boolean).map(String);
  const parts: string[] = [];
  ws.eachRow((row) => parts.push(JSON.stringify(row.values)));
  return { headers, text: parts.join('\n') };
}

describe('GET /projects/:id/tasks/export (B-10)', () => {
  it('without finance:read there is no Amount column and no amount anywhere in the sheet', async () => {
    const svc = makeExportService();
    const { buffer } = await svc.exportTasksExcel(59, { includeMoney: false });
    const { headers, text } = await sheetText(buffer);
    expect(headers).toContain('Est. Hours');
    expect(headers).not.toContain('Amount (₪)');
    expect(text).not.toContain('48765');
  });

  it('with finance:read the Amount column is there', async () => {
    const svc = makeExportService();
    const { buffer } = await svc.exportTasksExcel(59, { includeMoney: true });
    const { headers, text } = await sheetText(buffer);
    expect(headers).toContain('Amount (₪)');
    expect(text).toContain('48765');
  });

  it('defaults to no money', async () => {
    const svc = makeExportService();
    const { buffer } = await svc.exportTasksExcel(59);
    expect((await sheetText(buffer)).headers).not.toContain('Amount (₪)');
  });

  function makeController() {
    const projectsService: any = {
      exportTasksExcel: jest.fn(async () => ({ buffer: Buffer.from('x'), filename: 'f.xlsx' })),
    };
    const access: any = { assertProjectAccess: jest.fn(async () => undefined) };
    return { ctrl: new ProjectsController(projectsService, access), projectsService, access };
  }
  const res = () => ({ set: jest.fn(), send: jest.fn() }) as any;

  it('checks project access before exporting (was missing)', async () => {
    const { ctrl, access, projectsService } = makeController();
    access.assertProjectAccess.mockRejectedValueOnce(new ForbiddenException());
    const r = res();
    await expect(ctrl.exportProjectTasks(PM, 59, r)).rejects.toThrow(ForbiddenException);
    expect(access.assertProjectAccess).toHaveBeenCalledWith(4, 59, false);
    expect(projectsService.exportTasksExcel).not.toHaveBeenCalled();
    expect(r.send).not.toHaveBeenCalled();
  });

  it('passes the caller’s finance grant (an Admin without finance gets no money)', async () => {
    const { ctrl, projectsService } = makeController();
    await ctrl.exportProjectTasks(ADMIN, 59, res());
    expect(projectsService.exportTasksExcel).toHaveBeenLastCalledWith(59, { includeMoney: false });
    await ctrl.exportProjectTasks(FINANCE_PM, 59, res());
    expect(projectsService.exportTasksExcel).toHaveBeenLastCalledWith(59, { includeMoney: true });
  });
});

describe('POST / PATCH /projects (B-13 / B-15)', () => {
  const stored = { budget: new Prisma.Decimal('900000.00'), estimatedValue: null };
  const row = { id: 59, name: 'Tower A', budget: new Prisma.Decimal('900000.00'), estimatedValue: new Prisma.Decimal('1'), actualCost: 5 };

  function makeController() {
    const projectsService: any = {
      create: jest.fn(async () => ({ ...row })),
      update: jest.fn(async () => ({ ...row })),
      setLeader: jest.fn(async () => ({ ...row, leader: { id: 7 } })),
      getMoneySnapshot: jest.fn(async () => stored),
    };
    // Round 4: PATCH and the leader route are leader-or-Admin; PM is the leader here.
    const access: any = { assertProjectManage: jest.fn(async () => undefined) };
    return { ctrl: new ProjectsController(projectsService, access), projectsService };
  }

  it('PATCH with a changed budget and no finance:write → 403, nothing written', async () => {
    const { ctrl, projectsService } = makeController();
    await expect(ctrl.update(PM, 59, { budget: 1 } as any)).rejects.toThrow(/You can't change the project budget — that needs permission to change financial data/);
    expect(projectsService.update).not.toHaveBeenCalled();
  });

  it('PATCH echoing the stored budget passes; the response has no project money', async () => {
    const { ctrl, projectsService } = makeController();
    const out: any = await ctrl.update(PM, 59, { name: 'Tower A2', budget: 900000, estimatedValue: null } as any);
    expect(projectsService.update).toHaveBeenCalled();
    expect(out).toEqual({ id: 59, name: 'Tower A' });
  });

  it('PATCH by a finance writer changes the budget and sees it echoed', async () => {
    const { ctrl } = makeController();
    const out: any = await ctrl.update(FINANCE_PM, 59, { budget: 1 } as any);
    expect(out.budget).toBeDefined();
  });

  it('POST with a budget and no finance:write → 403', async () => {
    const { ctrl, projectsService } = makeController();
    await expect(ctrl.create(PM, { name: 'P', budget: 10 } as any)).rejects.toThrow(ForbiddenException);
    expect(projectsService.create).not.toHaveBeenCalled();
    const out: any = await ctrl.create(PM, { name: 'P' } as any);
    expect(out.budget).toBeUndefined();
  });

  it('PATCH /projects/:id/leader echo drops project money too', async () => {
    const { ctrl } = makeController();
    const out: any = await ctrl.setLeader(PM, 59, 7);
    expect(out).toEqual({ id: 59, name: 'Tower A', leader: { id: 7 } });
  });
});
