/**
 * Permission messages (2026-11-20) — `notify.apiError` shows a 403 as a
 * "No permission" alert (lock, neutral/amber, ref chip, no "Copy
 * details") instead of the red crash-style business-rule card.
 * Everything else keeps its old rendering.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(() => 'toast-id'), dismiss: vi.fn() },
}));

import { toast } from 'sonner';
import { notify, isPermissionDenied, getPermissionMessage, apiErrorCode, apiErrorDetails } from './notify';

const custom = toast.custom as unknown as ReturnType<typeof vi.fn>;

function axiosError(status: number, data: unknown, url = '/users/50', method = 'patch') {
  return { message: `Request failed with status code ${status}`, response: { status, data }, config: { url, method } };
}

/** Props of the card the last notify call rendered, plus the Sonner options. */
function lastCard(): { props: any; options: any } {
  const [renderFn, options] = custom.mock.calls[custom.mock.calls.length - 1];
  const element = (renderFn as (t: string) => any)('toast-id');
  return { props: element.props, options };
}

const PERMISSION_403 = {
  success: false,
  error: {
    code: 'PERMISSION_DENIED',
    message: "Only an Admin can change a user's access role.",
    details: { field: 'roleId' },
  },
};

beforeEach(() => {
  custom.mockClear();
  // buildDiagnosticDetails (Copy details) reads window.location + navigator.
  vi.stubGlobal('window', { location: { href: 'http://localhost/people' } });
});

describe('notify.apiError — permission 403', () => {
  it('renders "No permission" with the server reason, a ref chip and no Copy details', () => {
    notify.apiError(axiosError(403, PERMISSION_403), 'Failed to update person');
    const { props, options } = lastCard();
    expect(props.variant).toBe('permission');
    expect(props.title).toBe('No permission');
    expect(props.description).toBe("Only an Admin can change a user's access role.");
    expect(props.code).toBe('USER-UPDATE-403');
    expect(props.copyDetails).toBeUndefined();
    expect(options.duration).toBe(8000);
    // Repeats of the same refusal collapse into one card.
    expect(options.id).toBe("permission:Only an Admin can change a user's access role.");
  });

  it('a plain 403 from an older API (no code) is still "No permission"; jargon-free fallback text', () => {
    notify.apiError(axiosError(403, { statusCode: 403, message: 'Forbidden resource' }), 'Failed');
    const { props } = lastCard();
    expect(props.variant).toBe('permission');
    expect(props.description).toBe("You don't have permission to do this. Ask your administrator for access.");
  });

  it('a 403 with a business-rule code of its own keeps the regular error alert', () => {
    notify.apiError(
      axiosError(403, { success: false, error: { code: 'ROLE_IS_SYSTEM', message: '"Admin" is a built-in role…', details: null } }),
      'Failed to rename role',
    );
    const { props } = lastCard();
    expect(props.variant).toBe('businessRule');
    expect(props.title).toBe('"Admin" is a built-in role…');
    expect(props.copyDetails).toEqual(expect.any(String));
  });

  it('other errors are unchanged: 409 → business rule with Copy details, 400 details → validation', () => {
    notify.apiError(axiosError(409, { success: false, error: { code: 'CONFLICT', message: 'Email already exists' } }), 'x');
    expect(lastCard().props).toMatchObject({ variant: 'businessRule', title: 'Email already exists' });
    expect(lastCard().props.copyDetails).toEqual(expect.any(String));

    notify.apiError(
      axiosError(400, { success: false, error: { code: 'BAD_REQUEST', message: 'Validation failed', details: ['email must be an email'] } }),
      'x',
    );
    expect(lastCard().props).toMatchObject({ variant: 'validation', issues: ['email must be an email'] });
  });
});

describe('isPermissionDenied / getPermissionMessage', () => {
  it.each([
    ['PERMISSION_DENIED envelope', axiosError(403, PERMISSION_403), true],
    ['plain 403 with the generic FORBIDDEN code', axiosError(403, { error: { code: 'FORBIDDEN', message: 'x' } }), true],
    ['403 without a body', axiosError(403, undefined), true],
    ['403 with a business-rule code', axiosError(403, { error: { code: 'SYSTEM_PRESET_READ_ONLY', message: 'x' } }), false],
    ['401', axiosError(401, { error: { code: 'UNAUTHORIZED' } }), false],
    ['404', axiosError(404, { error: { code: 'NOT_FOUND' } }), false],
    ['network error', { message: 'Network Error' }, false],
    ['null', null, false],
  ])('%s → %s', (_label, err, expected) => {
    expect(isPermissionDenied(err)).toBe(expected);
  });

  it.each([
    ['400 MONTHLY_NOT_YET_COMPUTED', axiosError(400, { success: false, error: { code: 'MONTHLY_NOT_YET_COMPUTED', message: 'x', details: null } })],
    ['409 CROSS_TASK_OVERLAP', axiosError(409, { success: false, error: { code: 'CROSS_TASK_OVERLAP', message: 'x', details: {} } })],
  ])('a 4xx business code is not a permission refusal (%s)', (_label, err) => {
    expect(isPermissionDenied(err)).toBe(false);
  });

  it('never returns axios\' "Request failed with status code 403"', () => {
    expect(getPermissionMessage(axiosError(403, undefined))).toBe(
      "You don't have permission to do this. Ask your administrator for access.",
    );
    expect(getPermissionMessage(axiosError(403, PERMISSION_403))).toBe("Only an Admin can change a user's access role.");
  });
});

/**
 * Envelope readers (2026-11-20). The API now forwards 4xx business codes
 * (MONTHLY_NOT_YET_COMPUTED, CROSS_TASK_OVERLAP, …) in
 * `{ success: false, error: { code, message, details } }`; the monthly
 * review drawer and the overlap dialog read them through these helpers.
 */
describe('apiErrorCode / apiErrorDetails', () => {
  const NOT_COMPUTED_400 = {
    success: false,
    error: {
      code: 'MONTHLY_NOT_YET_COMPUTED',
      message: 'Monthly row not computed yet — click "חישוב מחדש" before approving.',
      details: null,
    },
  };

  it('reads the business code from the envelope (what the monthly review drawer checks)', () => {
    expect(apiErrorCode(axiosError(400, NOT_COMPUTED_400, '/hr/monthly/5/2026/11/approve', 'post'))).toBe(
      'MONTHLY_NOT_YET_COMPUTED',
    );
  });

  it('reads status-derived codes too', () => {
    expect(apiErrorCode(axiosError(409, { success: false, error: { code: 'CONFLICT', message: 'x', details: null } }))).toBe('CONFLICT');
  });

  it.each([
    ['code at the top of the body (not the envelope)', axiosError(400, { code: 'MONTHLY_NOT_YET_COMPUTED', message: 'x' })],
    ['empty code', axiosError(400, { error: { code: '' } })],
    ['non-string code', axiosError(400, { error: { code: 42 } })],
    ['403 without a body', axiosError(403, undefined)],
    ['network error', { message: 'Network Error' }],
    ['null', null],
  ])('null for %s', (_label, err) => {
    expect(apiErrorCode(err)).toBeNull();
  });

  it('returns the envelope details, or null when absent', () => {
    const details = { date: '2026-11-20', conflicts: [{ id: 1 }] };
    expect(apiErrorDetails(axiosError(409, { success: false, error: { code: 'CROSS_TASK_OVERLAP', message: 'x', details } }))).toEqual(details);
    expect(apiErrorDetails(axiosError(400, NOT_COMPUTED_400))).toBeNull();
    expect(apiErrorDetails({ message: 'Network Error' })).toBeNull();
  });

  it('notify.apiError renders a 4xx business code as the regular business-rule alert with the server message', () => {
    notify.apiError(axiosError(400, NOT_COMPUTED_400, '/hr/monthly/5/2026/11/approve', 'post'), 'Approve failed');
    const { props } = lastCard();
    expect(props).toMatchObject({ variant: 'businessRule', title: NOT_COMPUTED_400.error.message });
    // The ref chip is still built from the request, not the envelope code.
    expect(props.code).toBe('HR-CREATE-400');
    expect(props.copyDetails).toEqual(expect.any(String));
  });
});
