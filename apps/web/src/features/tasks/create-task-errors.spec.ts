/**
 * Create-task modal · server-side missing fields (2026-11-21). The
 * modal's onError lights its red fields from `createTaskFieldErrors`.
 */
import { describe, it, expect } from 'vitest';
import { createTaskFieldErrors } from './create-task-errors';

function axiosError(status: number, data: unknown) {
  return { message: `Request failed with status code ${status}`, response: { status, data }, config: { url: '/tasks', method: 'post' } };
}

function missing400(fields: unknown) {
  return axiosError(400, {
    success: false,
    error: { code: 'MISSING_REQUIRED_FIELDS', message: 'x', details: { missing: fields } },
  });
}

describe('createTaskFieldErrors', () => {
  it('returns the envelope fields as the modal keys', () => {
    expect(createTaskFieldErrors(missing400(['zoneId']))).toEqual(new Set(['zoneId']));
    expect(createTaskFieldErrors(missing400(['serviceTypeId']))).toEqual(new Set(['serviceTypeId']));
  });

  it('maps deliverableTemplateId onto the single Deliverable field (projectDeliverableId)', () => {
    expect(createTaskFieldErrors(missing400(['deliverableTemplateId', 'zoneId']))).toEqual(
      new Set(['projectDeliverableId', 'zoneId']),
    );
  });

  it.each([
    ['the old top-level shape', axiosError(400, { error: 'missing_required_fields', message: 'x', missing: ['zoneId'] })],
    ['another business code', axiosError(400, { success: false, error: { code: 'TIME_ENTRY_TASK_REQUIRED', message: 'x', details: { missing: ['taskId'] } } })],
    ['class-validator details', axiosError(400, { success: false, error: { code: 'BAD_REQUEST', message: 'Validation failed', details: ['name should not be empty'] } })],
    ['an empty list', missing400([])],
    ['a network error', { message: 'Network Error' }],
  ])('null for %s', (_label, err) => {
    expect(createTaskFieldErrors(err)).toBeNull();
  });
});
