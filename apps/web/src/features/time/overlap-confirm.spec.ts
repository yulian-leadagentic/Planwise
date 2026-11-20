/**
 * Overlap dialog (informational, 2026-11-20). The fixtures are the exact
 * body HttpExceptionFilter writes for `new ConflictException({ code,
 * message, details })` (see the "4xx business codes" block in
 * apps/api/src/common/filters/http-exception.filter.spec.ts), wrapped the
 * way axios rejects. Both overlap codes are hard blocks: one read-only
 * dialog, no retry, no toast on top.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(() => 'toast-id'), dismiss: vi.fn() },
}));

import { notify } from '@/lib/notify';
import { extractTimeOverlap, runWithOverlapCheck } from './overlap-confirm';

function axiosError(status: number, data: unknown) {
  return {
    message: `Request failed with status code ${status}`,
    response: { status, data },
    config: { url: '/time-entries', method: 'post' },
  };
}

const ATTEMPTED = { startTime: '09:00', endTime: '10:00' };

const CROSS_CONFLICTS = [
  { id: 7, taskId: 3, taskName: 'Design review', taskCode: 'T-3', startTime: '09:30', endTime: '11:00' },
];
// Same-task conflicts carry no task fields (assertNoTimeOverlap in time-entries.service).
const SAME_CONFLICTS = [{ id: 9, startTime: '08:30', endTime: '09:15' }];

/** HttpExceptionFilter output for each overlap 409. */
const CROSS_TASK_409 = {
  success: false,
  error: {
    code: 'CROSS_TASK_OVERLAP',
    message: 'This entry overlaps with time logged on another task.',
    details: { date: '2026-11-20', attempted: ATTEMPTED, conflicts: CROSS_CONFLICTS },
  },
};
const SAME_TASK_409 = {
  success: false,
  error: {
    code: 'SAME_TASK_OVERLAP',
    message: 'Time overlap on the same task is not allowed.',
    details: { date: '2026-11-20', attempted: ATTEMPTED, conflicts: SAME_CONFLICTS },
  },
};

describe('extractTimeOverlap', () => {
  it('CROSS_TASK_OVERLAP → code, date and conflicts from the envelope', () => {
    expect(extractTimeOverlap(axiosError(409, CROSS_TASK_409))).toEqual({
      code: 'CROSS_TASK_OVERLAP',
      date: '2026-11-20',
      conflicts: CROSS_CONFLICTS,
    });
  });

  it('SAME_TASK_OVERLAP → the same shape (both are hard blocks)', () => {
    expect(extractTimeOverlap(axiosError(409, SAME_TASK_409))).toEqual({
      code: 'SAME_TASK_OVERLAP',
      date: '2026-11-20',
      conflicts: SAME_CONFLICTS,
    });
  });

  it('tolerates missing or malformed details (empty list rather than a crash)', () => {
    const noDetails = { success: false, error: { code: 'CROSS_TASK_OVERLAP', message: 'x', details: null } };
    expect(extractTimeOverlap(axiosError(409, noDetails))).toEqual({ code: 'CROSS_TASK_OVERLAP', date: '', conflicts: [] });

    const odd = { success: false, error: { code: 'SAME_TASK_OVERLAP', message: 'x', details: { date: 20261120, conflicts: 'x' } } };
    expect(extractTimeOverlap(axiosError(409, odd))).toEqual({ code: 'SAME_TASK_OVERLAP', date: '', conflicts: [] });
  });

  it.each([
    ['a 409 without a business code', axiosError(409, { success: false, error: { code: 'CONFLICT', message: 'x', details: null } })],
    ['a validation 400', axiosError(400, { success: false, error: { code: 'BAD_REQUEST', message: 'Validation failed', details: ['x'] } })],
    // The pre-envelope shapes the old reader looked for — not what the API sends.
    ['code at the top of the body', axiosError(409, { code: 'CROSS_TASK_OVERLAP', details: CROSS_TASK_409.error.details })],
    ['code nested in message', axiosError(409, { message: { code: 'SAME_TASK_OVERLAP', details: SAME_TASK_409.error.details } })],
    ['network error', { message: 'Network Error' }],
    ['null', null],
  ])('returns null for %s', (_label, err) => {
    expect(extractTimeOverlap(err)).toBeNull();
  });
});

describe('runWithOverlapCheck (what withOverlapCheck runs)', () => {
  let apiError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    apiError = vi.spyOn(notify, 'apiError').mockImplementation(() => 'toast-id');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['CROSS_TASK_OVERLAP', CROSS_TASK_409],
    ['SAME_TASK_OVERLAP', SAME_TASK_409],
  ])('%s: opens the dialog once — no retry, no error toast', async (code, body) => {
    const run = vi.fn().mockRejectedValue(axiosError(409, body));
    const onOverlap = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await runWithOverlapCheck(run, onOverlap, { onSuccess, onError });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(); // nothing like a confirmOverlap flag is passed
    expect(onOverlap).toHaveBeenCalledTimes(1);
    expect(onOverlap).toHaveBeenCalledWith(expect.objectContaining({ code, date: '2026-11-20' }));
    expect(apiError).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('any other failure → the usual error toast, no dialog', async () => {
    const err = axiosError(400, { success: false, error: { code: 'TIME_ENTRY_BUCKET_INACTIVE', message: 'x', details: null } });
    const run = vi.fn().mockRejectedValue(err);
    const onOverlap = vi.fn();

    await runWithOverlapCheck(run, onOverlap);

    expect(run).toHaveBeenCalledTimes(1);
    expect(onOverlap).not.toHaveBeenCalled();
    expect(apiError).toHaveBeenCalledWith(err, 'Failed to log time');
  });

  it('success → onSuccess, no dialog, no toast', async () => {
    const run = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const onOverlap = vi.fn();
    const onSuccess = vi.fn();

    await runWithOverlapCheck(run, onOverlap, { onSuccess });

    expect(run).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onOverlap).not.toHaveBeenCalled();
    expect(apiError).not.toHaveBeenCalled();
  });
});
