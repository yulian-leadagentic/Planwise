import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('./client', () => ({ default: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));

import { dataImportApi } from './data-import.api';

/**
 * The API wraps every payload as `{ success: true, data }`. The data-import
 * client used to return that envelope as the payload, so the wizard read
 * `summary` / `credentials` off the wrapper (undefined).
 */
describe('dataImportApi — unwraps the response envelope', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
  });

  it('commit returns { import, summary, credentials }', async () => {
    const payload = {
      import: { id: 5 },
      summary: { createdCount: 1, updatedCount: 0, skippedCount: 0, errorCount: 0 },
      credentials: [{ email: 'a@b.c', firstName: 'A', lastName: 'B', password: 'Ab3dEf7hJk9m' }],
    };
    post.mockResolvedValue({ data: { success: true, data: payload } });
    const res = await dataImportApi.commit('users', new Blob(['x']) as File, 'insert');
    expect(res).toEqual(payload);
    expect(res.credentials?.[0].password).toBe('Ab3dEf7hJk9m');
  });

  it('history returns the array, not the envelope', async () => {
    get.mockResolvedValue({ data: { success: true, data: [{ id: 1 }, { id: 2 }] } });
    await expect(dataImportApi.history()).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('passes through a body that is not wrapped', async () => {
    get.mockResolvedValue({ data: [{ id: 3 }] });
    await expect(dataImportApi.historyRows(3)).resolves.toEqual([{ id: 3 }]);
  });
});
