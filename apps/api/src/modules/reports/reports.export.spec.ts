/**
 * Permissions round 2 (2026-11-20) — report exports and money.
 *
 * File exports bypass the global finance interceptor, so they enforce
 * the rule themselves:
 *   • B-02: `timesheet-detailed` (the Timesheet page's "Export Excel")
 *     drops the Cost / Currency columns and the per-currency cost totals
 *     for callers without finance:read — cost ÷ hours gives each
 *     person's hourly rate history.
 *   • B-03: `cost-by-project` (any `cost-*` type) is a cost report:
 *     finance:read or 403, like the JSON `/reports/cost/*` routes.
 *   • B-19: `GET /reports/milestones` drops `LabelMilestone.amount`.
 */
import { ForbiddenException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

import { ReportsController } from './reports.controller';
import { ReportsService, isCostExportType, scrubTimesheetCost } from './reports.service';
import { ALL_TIME_SCOPE } from '../../common/services/employee-scope.service';

// Round 3 (2026-11-22) — the controller now resolves the caller's
// employee scope; these finance tests run as someone who sees everyone.
function scopeStub(): any {
  return {
    timeEntryScope: jest.fn(async () => ALL_TIME_SCOPE),
    visibleUserIds: jest.fn(async () => 'all'),
  };
}

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const REPORTS_EXPORTER = {
  id: 5,
  isAdmin: false,
  roleModules: [perm('/reports', { canRead: true, canExport: true })],
};
const FINANCE_EXPORTER = {
  id: 6,
  isAdmin: false,
  roleModules: [perm('/reports', { canRead: true, canExport: true }), perm('/finance', { canRead: true })],
};

function makePrisma() {
  const entry = {
    id: 1,
    date: new Date('2026-11-02T00:00:00Z'),
    startTime: '08:00',
    endTime: '12:00',
    minutes: 240,
    note: 'modeling',
    user: { id: 7, firstName: 'Dana', lastName: 'Levi' },
    task: {
      id: 11,
      name: 'Model L2',
      projectId: 59,
      project: { id: 59, name: 'Tower A', number: '1001' },
      zone: null,
      deliverableTemplate: null,
      phase: null,
    },
  };
  return {
    timeEntry: { findMany: jest.fn(async () => [entry]) },
    zone: { findMany: jest.fn(async () => []) },
    userSeniority: {
      findMany: jest.fn(async () => [
        {
          userId: 7,
          startDate: new Date('2020-01-01T00:00:00Z'),
          endDate: null,
          seniorityLevel: { name: 'Senior', defaultHourlyCost: '150.00', currency: 'ILS' },
        },
      ]),
    },
  } as any;
}

async function headersOf(buffer: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const sheet = wb.getWorksheet('Timesheet')!;
  return (sheet.getRow(1).values as any[]).filter(Boolean).map(String);
}

async function allCellText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const parts: string[] = [];
  wb.getWorksheet('Timesheet')!.eachRow((row) => parts.push(JSON.stringify(row.values)));
  return parts.join('\n');
}

function fakeRes() {
  return { set: jest.fn(), send: jest.fn() } as any;
}

describe('GET /reports/export — timesheet-detailed (B-02)', () => {
  it('without finance:read the workbook has no Cost / Currency columns and no cost totals', async () => {
    const svc = new ReportsService(makePrisma());
    const buf = await svc.exportReport('timesheet-detailed', 'excel', {} as any, { canSeeFinance: false, scope: ALL_TIME_SCOPE });
    const headers = await headersOf(buf);
    expect(headers).toContain('Hours');
    expect(headers).not.toContain('Cost');
    expect(headers).not.toContain('Currency');
    const text = await allCellText(buf);
    expect(text).not.toContain('600'); // 4h × 150 = 600 → nowhere in the file
    expect(text).not.toContain('Total (ILS)');
  });

  it('with finance:read the Cost column and per-currency totals are there', async () => {
    const svc = new ReportsService(makePrisma());
    const buf = await svc.exportReport('timesheet-detailed', 'excel', {} as any, { canSeeFinance: true, scope: ALL_TIME_SCOPE });
    const headers = await headersOf(buf);
    expect(headers).toEqual(expect.arrayContaining(['Cost', 'Currency']));
    const text = await allCellText(buf);
    expect(text).toContain('600');
    expect(text).toContain('Total (ILS)');
  });

  it('the service defaults to no money when the caller does not say', async () => {
    const svc = new ReportsService(makePrisma());
    const buf = await svc.exportReport('timesheet-detailed', 'excel', {} as any);
    expect(await headersOf(buf)).not.toContain('Cost');
  });

  it('the controller passes the caller’s finance grant through', async () => {
    const reportsService: any = { exportReport: jest.fn(async () => Buffer.from('x')) };
    const ctrl = new ReportsController(reportsService, scopeStub());
    await ctrl.exportReport(REPORTS_EXPORTER, 'timesheet-detailed', 'excel', {} as any, fakeRes());
    expect(reportsService.exportReport).toHaveBeenLastCalledWith('timesheet-detailed', 'excel', {}, { canSeeFinance: false, scope: ALL_TIME_SCOPE });
    await ctrl.exportReport(FINANCE_EXPORTER, 'timesheet-detailed', 'excel', {} as any, fakeRes());
    expect(reportsService.exportReport).toHaveBeenLastCalledWith('timesheet-detailed', 'excel', {}, { canSeeFinance: true, scope: ALL_TIME_SCOPE });
  });

  it('the JSON route and the export share one scrub', () => {
    const out = scrubTimesheetCost({
      rows: [{ id: 1, hours: 4, cost: 600, currency: 'ILS' }],
      totals: { totalHours: 4, rowCount: 1, byCurrency: [{ currency: 'ILS', totalHours: 4, totalCost: 600 }] },
    });
    expect(out.rows[0]).toEqual({ id: 1, hours: 4, cost: null, currency: null });
    expect(out.totals).toEqual({ totalHours: 4, rowCount: 1, byCurrency: [] });
  });
});

describe('GET /reports/export — cost-* types (B-03)', () => {
  it('cost-by-project without finance:read → 403 before any query', async () => {
    const reportsService: any = { exportReport: jest.fn() };
    const ctrl = new ReportsController(reportsService, scopeStub());
    const res = fakeRes();
    await expect(ctrl.exportReport(REPORTS_EXPORTER, 'cost-by-project', 'excel', {} as any, res)).rejects.toThrow(
      ForbiddenException,
    );
    expect(reportsService.exportReport).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('every cost-* spelling counts (including ones that fall through to the default case)', () => {
    expect(isCostExportType('cost-by-project')).toBe(true);
    expect(isCostExportType('cost-by-task')).toBe(true);
    expect(isCostExportType('Cost-By-Label')).toBe(true);
    expect(isCostExportType('timesheet-detailed')).toBe(false);
    expect(isCostExportType(undefined)).toBe(false);
  });

  it('the service refuses it too when called without the grant', async () => {
    const svc = new ReportsService(makePrisma());
    await expect(svc.exportReport('cost-by-project', 'excel', {} as any)).rejects.toThrow(ForbiddenException);
  });

  it('a finance:read caller still gets it', async () => {
    const reportsService: any = { exportReport: jest.fn(async () => Buffer.from('x')) };
    const ctrl = new ReportsController(reportsService, scopeStub());
    const res = fakeRes();
    await ctrl.exportReport(FINANCE_EXPORTER, 'cost-by-project', 'excel', {} as any, res);
    expect(reportsService.exportReport).toHaveBeenCalledWith('cost-by-project', 'excel', {}, { canSeeFinance: true });
    expect(res.send).toHaveBeenCalled();
  });
});

describe('GET /reports/milestones (B-19)', () => {
  it('drops LabelMilestone.amount for callers without finance:read', async () => {
    const rows = [{ id: 1, name: 'Permit', amount: '25000.00', label: { id: 3, name: 'A' } }];
    const reportsService: any = { milestonesReport: jest.fn(async () => rows) };
    const ctrl = new ReportsController(reportsService, scopeStub());
    expect(await ctrl.milestones(REPORTS_EXPORTER, {} as any)).toEqual([{ id: 1, name: 'Permit', label: { id: 3, name: 'A' } }]);
    expect(await ctrl.milestones(FINANCE_EXPORTER, {} as any)).toBe(rows);
  });
});
