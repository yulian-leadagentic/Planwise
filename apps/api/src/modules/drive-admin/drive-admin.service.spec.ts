/**
 * Audit-trail spec for DriveAdminService.
 *
 * The security-critical invariant this file locks in: EVERY mutation
 * + the test-connection path writes an ActivityLog entry with the
 * right action code AND without the raw service-account key. If a
 * future refactor drops one of those audit calls, or leaks the key
 * into metadata, this file fails first.
 */
import { DriveAdminService } from './drive-admin.service';

// Stub googleapis at the module level so `test()` doesn't try to hit
// Google. The drives.get response shape is what the service reads.
jest.mock('googleapis', () => {
  const drivesGet = jest.fn();
  return {
    google: {
      auth: {
        GoogleAuth: jest.fn().mockImplementation(() => ({})),
      },
      drive: jest.fn(() => ({ drives: { get: drivesGet } })),
      __drivesGet: drivesGet, // exposed for per-test control
    },
  };
});

const { google } = jest.requireMock('googleapis');
const drivesGetMock: jest.Mock = google.__drivesGet;

const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
});

function makeService() {
  const rowShape = {
    id: 1,
    organizationId: null as number | null,
    enabled: false,
    sharedDriveId: '0A123456789',
    rootFolderId: null as string | null,
    saCiphertext: Buffer.from('ciphertext-bytes'),
    saIv: Buffer.from('iv-12-bytes-!'),
    saTag: Buffer.from('tag-16-bytes---!'),
    keyVersion: 1,
    updatedAt: new Date('2026-08-10T12:00:00Z'),
  };

  let current: typeof rowShape | null = null;

  const prisma = {
    orgDriveConfig: {
      findFirst: jest.fn(async () => current),
      create: jest.fn(async ({ data }: any) => {
        current = { ...rowShape, ...data };
        return current;
      }),
      update: jest.fn(async ({ data }: any) => {
        current = { ...(current ?? rowShape), ...data };
        return current;
      }),
    },
  };

  const crypto = {
    encrypt: jest.fn(() => ({
      ciphertext: Buffer.from('enc'),
      iv: Buffer.from('iv'),
      tag: Buffer.from('tag'),
      keyVersion: 1,
    })),
    decrypt: jest.fn(() => SA_JSON),
    fingerprint: jest.fn(() => 'abcd'),
  };

  const activity = { write: jest.fn(async () => undefined) };

  const svc = new DriveAdminService(prisma as any, crypto as any, activity as any);

  return { svc, prisma, crypto, activity, seed: (row: typeof rowShape | null) => { current = row; } };
}

describe('DriveAdminService — audit trail', () => {
  beforeEach(() => {
    drivesGetMock.mockReset();
  });

  it('audits drive.config.updated with created=true on first upsert', async () => {
    const { svc, activity } = makeService();
    await svc.upsert({ sharedDriveId: '0A-drive', serviceAccountKey: SA_JSON, enabled: true } as any, 42, '10.0.0.1');

    expect(activity.write).toHaveBeenCalledTimes(1);
    const call = activity.write.mock.calls[0][0];
    expect(call.action).toBe('drive.config.updated');
    expect(call.actorUserId).toBe(42);
    expect(call.metadata).toMatchObject({ created: true, rotatedKey: true, enabled: true });
  });

  it('audits drive.config.updated with rotatedKey=false when the key is not resupplied', async () => {
    const { svc, activity, seed } = makeService();
    seed({
      id: 1, organizationId: null, enabled: false, sharedDriveId: 'old', rootFolderId: null,
      saCiphertext: Buffer.from('c'), saIv: Buffer.from('i'), saTag: Buffer.from('t'),
      keyVersion: 1, updatedAt: new Date(),
    });
    await svc.upsert({ sharedDriveId: 'new', enabled: false } as any, 42, null);

    expect(activity.write).toHaveBeenCalledTimes(1);
    const call = activity.write.mock.calls[0][0];
    expect(call.action).toBe('drive.config.updated');
    expect(call.metadata).toMatchObject({ created: false, rotatedKey: false });
  });

  it('audits drive.config.enabled vs drive.config.disabled from setEnabled()', async () => {
    const { svc, activity, seed } = makeService();
    seed({
      id: 1, organizationId: null, enabled: false, sharedDriveId: 'x', rootFolderId: null,
      saCiphertext: Buffer.from('c'), saIv: Buffer.from('i'), saTag: Buffer.from('t'),
      keyVersion: 1, updatedAt: new Date(),
    });

    await svc.setEnabled(true, 42, null);
    await svc.setEnabled(false, 42, null);

    expect(activity.write).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'drive.config.enabled', metadata: { enabled: true } }));
    expect(activity.write).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'drive.config.disabled', metadata: { enabled: false } }));
  });

  it('audits drive.config.tested with ok=true on successful test', async () => {
    const { svc, activity, seed } = makeService();
    seed({
      id: 1, organizationId: null, enabled: true, sharedDriveId: '0A-drive', rootFolderId: null,
      saCiphertext: Buffer.from('c'), saIv: Buffer.from('i'), saTag: Buffer.from('t'),
      keyVersion: 1, updatedAt: new Date(),
    });
    drivesGetMock.mockResolvedValueOnce({ data: { id: '0A-drive', name: 'Planwise Prod' } });

    const res = await svc.test(42, null);
    expect(res.ok).toBe(true);
    expect(activity.write).toHaveBeenCalledTimes(1);
    expect(activity.write.mock.calls[0][0]).toMatchObject({
      action: 'drive.config.tested',
      metadata: { ok: true, driveId: '0A-drive', error: null },
    });
  });

  it('audits drive.config.tested with ok=false + error on failed test', async () => {
    const { svc, activity, seed } = makeService();
    seed({
      id: 1, organizationId: null, enabled: true, sharedDriveId: '0A-drive', rootFolderId: null,
      saCiphertext: Buffer.from('c'), saIv: Buffer.from('i'), saTag: Buffer.from('t'),
      keyVersion: 1, updatedAt: new Date(),
    });
    drivesGetMock.mockRejectedValueOnce(new Error('Requested entity was not found.'));

    const res = await svc.test(42, null);
    expect(res.ok).toBe(false);
    expect(activity.write).toHaveBeenCalledTimes(1);
    const meta = activity.write.mock.calls[0][0].metadata;
    expect(meta.ok).toBe(false);
    expect(meta.driveId).toBeNull();
    expect(meta.error).toContain('not found');
  });

  it('NEVER passes the raw SA key into audit metadata', async () => {
    // Locks in the invariant documented on the audit() helper. Any
    // regression that widens the metadata to include the raw key or
    // the decrypted credentials fails this test.
    const { svc, activity, seed } = makeService();

    // Fresh create (has the key on the DTO)
    await svc.upsert({ sharedDriveId: 'x', serviceAccountKey: SA_JSON, enabled: true } as any, 42, null);

    // Test (decrypts and holds the key in-scope)
    seed({
      id: 1, organizationId: null, enabled: true, sharedDriveId: 'x', rootFolderId: null,
      saCiphertext: Buffer.from('c'), saIv: Buffer.from('i'), saTag: Buffer.from('t'),
      keyVersion: 1, updatedAt: new Date(),
    });
    drivesGetMock.mockResolvedValueOnce({ data: { id: 'x', name: 'x' } });
    await svc.test(42, null);

    for (const [entry] of activity.write.mock.calls) {
      const serialized = JSON.stringify(entry.metadata ?? {});
      expect(serialized).not.toContain('client_email');
      expect(serialized).not.toContain('private_key');
      expect(serialized).not.toContain('sa@example.iam');
      expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    }
  });
});
