import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { UsersImporterService, toReportJson, generateTempPassword } from './importers/users-importer.service';
import { DataImportController } from './data-import.controller';

/**
 * Permissions round 3 (2026-11-22) — initial passwords of imported users
 * are shown ONCE (commit response) and never stored; the pay rate never
 * reaches the per-row import report either.
 */

const SHEET_ROW = {
  Email: 'dana@amec.co.il',
  'First Name': 'Dana',
  'Last Name': 'Levi',
  Role: 'Engineer',
  'Hourly Rate': '120',
};

function makeImporter() {
  const rowsWritten: any[] = [];
  const createdUsers: any[] = [];
  const tx: any = {
    user: {
      create: jest.fn(async ({ data }: any) => {
        const u = { id: 500 + createdUsers.length, ...data };
        createdUsers.push(u);
        return u;
      }),
      update: jest.fn(async () => ({})),
    },
    userSeniority: { create: jest.fn() },
  };
  const prisma: any = {
    role: { findMany: jest.fn(async () => [{ id: 3, name: 'Engineer' }]) },
    seniorityLevel: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => [{ email: 'taken@amec.co.il' }]) },
    orgUnit: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    dataImportRow: { create: jest.fn(async ({ data }: any) => rowsWritten.push(data)) },
  };
  const usersService: any = {
    ensureBpForUser: jest.fn(async () => ({ bpId: 900 })),
    syncEmployeeBpRole: jest.fn(async () => undefined),
  };
  return { importer: new UsersImporterService(prisma, usersService), prisma, tx, rowsWritten, createdUsers };
}

describe('UsersImporterService — no secrets in storage', () => {
  it('validate generates no password (and so returns none)', async () => {
    const { importer } = makeImporter();
    const [row] = await importer.validateRows([SHEET_ROW], { canSeeFinance: true });
    expect(row.errors).toEqual([]);
    expect(row.data).not.toHaveProperty('generatedPassword');
    expect(JSON.stringify(row)).not.toMatch(/password/i);
  });

  it('commit creates the user with mustChangePassword and returns the password once', async () => {
    const { importer, createdUsers, rowsWritten } = makeImporter();
    const validated = await importer.validateRows([SHEET_ROW], { canSeeFinance: true });
    const result = await importer.commit({ importId: 1, rows: validated, mode: 'insert', userId: 1 });

    expect(result.createdCount).toBe(1);
    expect(result.credentials).toHaveLength(1);
    const cred = result.credentials![0];
    expect(cred).toMatchObject({ email: 'dana@amec.co.il', firstName: 'Dana', lastName: 'Levi' });
    expect(cred.password).toMatch(/^[A-Za-z0-9]{12}$/);

    const user = createdUsers[0];
    expect(user.mustChangePassword).toBe(true);
    expect(await bcrypt.compare(cred.password, user.password)).toBe(true);

    // The import report row has no password, no hash and no pay rate.
    const stored = JSON.stringify(rowsWritten);
    expect(stored).not.toContain(cred.password);
    expect(stored).not.toContain(user.password);
    expect(rowsWritten[0].afterJson).not.toHaveProperty('generatedPassword');
    expect(rowsWritten[0].afterJson).not.toHaveProperty('salaryHourly');
    expect(rowsWritten[0].afterJson).toMatchObject({ email: 'dana@amec.co.il', userId: 500 });
  });

  it('skipped and failed rows store no pay rate either', async () => {
    const { importer, tx, rowsWritten } = makeImporter();
    const validated = await importer.validateRows(
      [
        { ...SHEET_ROW, Email: 'taken@amec.co.il' }, // conflicts → skipped
        { ...SHEET_ROW, Email: 'boom@amec.co.il' }, // create throws → failed
      ],
      { canSeeFinance: true },
    );
    tx.user.create.mockRejectedValueOnce(new Error('race: email taken'));
    const result = await importer.commit({ importId: 1, rows: validated, mode: 'insert', userId: 1 });
    expect(result).toMatchObject({ skippedCount: 1, errorCount: 1, createdCount: 0, credentials: [] });
    for (const r of rowsWritten) {
      expect(r.afterJson).not.toHaveProperty('salaryHourly');
      expect(r.afterJson).not.toHaveProperty('generatedPassword');
    }
  });

  it('toReportJson drops secret keys and undefined values', () => {
    expect(
      toReportJson({ email: 'a@b.c', generatedPassword: 'x', password: 'y', salaryHourly: 120, phone: undefined }, { userId: 3 }),
    ).toEqual({ email: 'a@b.c', userId: 3 });
    expect(toReportJson(null)).toBeNull();
  });

  it('generateTempPassword gives 12 unambiguous characters', () => {
    for (let i = 0; i < 50; i++) expect(generateTempPassword()).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
  });
});

describe('DataImportController — commit returns credentials once; history never shows secrets', () => {
  const IMPORTER_USER = {
    id: 1,
    isAdmin: true,
    roleModules: [{ module: { route: '/data-import', name: 'Data Import' }, canRead: true, canWrite: true, canDelete: true }],
  };

  function makeController(commitResult: any) {
    const prisma: any = {
      dataImport: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 5 })),
        update: jest.fn(async ({ data }: any) => ({ id: 5, ...data })),
        findUnique: jest.fn(),
      },
      dataImportRow: { findMany: jest.fn(async () => []) },
    };
    const parser: any = { parse: jest.fn(async () => ({ rows: [{}], fileHash: 'h', headers: [] })) };
    const usersImporter: any = {
      validateRows: jest.fn(async () => [{ rowIndex: 1, data: {}, errors: [], conflictsWithExisting: false }]),
      commit: jest.fn(async () => commitResult),
      rollback: jest.fn(async () => ({ deletedCount: 2, restoredCount: 0 })),
    };
    const activityLog: any = { write: jest.fn(async () => undefined) };
    const projectAccess: any = { invalidateSubordinateCache: jest.fn() };
    const ctrl = new DataImportController(prisma, parser, usersImporter, activityLog, projectAccess);
    return { ctrl, prisma, activityLog, projectAccess, usersImporter };
  }

  const FILE = { buffer: Buffer.from('x'), originalname: 'people.xlsx', size: 1 };

  it('puts credentials beside the summary, not in it, and keeps them out of the audit row', async () => {
    const credentials = [{ email: 'dana@amec.co.il', firstName: 'Dana', lastName: 'Levi', password: 'S3cretPassw0' }];
    const { ctrl, prisma, activityLog, projectAccess } = makeController({
      createdCount: 1,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      credentials,
    });
    const res: any = await ctrl.commit(IMPORTER_USER, 'users', FILE, 'insert');

    expect(res.credentials).toEqual(credentials);
    expect(res.summary).toEqual({ createdCount: 1, updatedCount: 0, skippedCount: 0, errorCount: 0 });
    expect(JSON.stringify(activityLog.write.mock.calls)).not.toContain('S3cretPassw0');
    expect(JSON.stringify(prisma.dataImport.update.mock.calls)).not.toContain('S3cretPassw0');
    // Imported users can join org units → subordinate memo dropped.
    expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalledTimes(1);
  });

  it('history rows strip a password / pay rate left in an old report row', async () => {
    const { ctrl, prisma } = makeController({});
    prisma.dataImport.findUnique.mockResolvedValue({ id: 5, userId: 1 });
    prisma.dataImportRow.findMany.mockResolvedValue([
      { id: 1, rowIndex: 1, outcome: 'created', afterJson: { email: 'a@b.c', generatedPassword: 'old', salaryHourly: 99 } },
      { id: 2, rowIndex: 2, outcome: 'failed', afterJson: null },
    ]);
    const rows: any[] = await ctrl.historyRows(IMPORTER_USER, 5);
    expect(rows[0].afterJson).toEqual({ email: 'a@b.c' });
    expect(rows[1].afterJson).toBeNull();
  });

  it('rolling back a contacts import is refused with ROLLBACK_NOT_SUPPORTED', async () => {
    const { ctrl, prisma, usersImporter } = makeController({});
    prisma.dataImport.findUnique.mockResolvedValue({ id: 6, userId: 1, target: 'contacts', status: 'committed', expiresAt: null });
    const err = await ctrl.rollback(IMPORTER_USER, 6).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'ROLLBACK_NOT_SUPPORTED' });
    expect(usersImporter.rollback).not.toHaveBeenCalled();
    expect(prisma.dataImport.update).not.toHaveBeenCalled();
  });

  it('rolling back a users import still works and drops the subordinate memo', async () => {
    const { ctrl, prisma, usersImporter, projectAccess } = makeController({});
    prisma.dataImport.findUnique.mockResolvedValue({ id: 7, userId: 1, target: 'users', status: 'committed', expiresAt: null });
    const res: any = await ctrl.rollback(IMPORTER_USER, 7);
    expect(usersImporter.rollback).toHaveBeenCalledWith(7);
    expect(res).toMatchObject({ deletedCount: 2 });
    expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalled();
  });
});
