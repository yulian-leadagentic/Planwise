import { describe, expect, it } from 'vitest';
import {
  isPickableService,
  isProjectPhaseName,
  PROJECT_PHASE_NAMES,
  qualificationSaveError,
  serviceOptions,
  withSavedServiceOption,
} from './service-options';
// The API's copy of the rule: the web mirror must not drift from it.
import {
  isPickableService as apiIsPickableService,
  PROJECT_PHASE_NAMES as API_PROJECT_PHASE_NAMES,
} from '../../../../api/src/modules/phases/service-phase-rule';

const rows = [
  { id: 1, name: 'Pre-Design' },
  { id: 2, name: 'Design' },
  { id: 3, name: 'Construction' },
  { id: 4, name: 'AFC' },
  { id: 5, name: 'Handover' },
  { id: 6, name: 'Maintenance' },
  { id: 7, name: 'תכנון מפורט' },
  { id: 8, name: 'תכנון סופי' },
  { id: 9, name: 'תכנון לביצוע' },
  { id: 10, name: 'BIM Coordination', code: 'BIM' },
  { id: 11, name: 'BIM Coordination BIM', isActive: false },
  { id: 12, name: 'ניהול מודל', code: 'MM' },
  { id: 13, name: 'Design Review' },
  { id: 14, name: 'Old', kind: 'phase' },
];

describe('PR-069 · Service picker options', () => {
  it('leaves the project phases out (before the cleanup runs)', () => {
    expect(serviceOptions(rows).map((r) => r.id)).toEqual([10, 12, 13]);
  });

  it('leaves out rows the cleanup marked as phase or deactivated', () => {
    expect(isPickableService({ id: 14, name: 'Old', kind: 'phase' })).toBe(false);
    expect(isPickableService({ id: 11, name: 'BIM Coordination BIM', isActive: false })).toBe(false);
  });

  it('keeps the value already selected, so an old template does not lose its Service', () => {
    expect(serviceOptions(rows, ['2']).map((r) => r.id)).toEqual([2, 10, 12, 13]);
    expect(serviceOptions(rows, [null, undefined, '', 11]).map((r) => r.id)).toEqual([10, 11, 12, 13]);
  });

  it('matches names ignoring case, spaces and punctuation', () => {
    expect(isProjectPhaseName('pre design')).toBe(true);
    expect(isProjectPhaseName('תכנון  לביצוע')).toBe(true);
    expect(isProjectPhaseName('Design Review')).toBe(false);
  });

  it('is the same rule as the API (/phases?scope=services)', () => {
    expect([...PROJECT_PHASE_NAMES]).toEqual([...API_PROJECT_PHASE_NAMES]);
    for (const r of rows) expect(isPickableService(r)).toBe(apiIsPickableService(r));
  });

  it('tolerates a missing list', () => {
    expect(serviceOptions(undefined)).toEqual([]);
  });

  it('withSavedServiceOption keeps a saved value the services-only list does not carry', () => {
    const services = [{ id: 10, name: 'BIM Coordination' }, { id: 12, name: 'ניהול מודל' }];
    expect(withSavedServiceOption(services, 2, 'Design')).toEqual([...services, { id: 2, name: 'Design' }]);
    expect(withSavedServiceOption(services, '10', 'BIM Coordination')).toEqual(services);
    expect(withSavedServiceOption(services, 7, null)).toEqual([...services, { id: 7, name: 'Service #7' }]);
    expect(withSavedServiceOption(services, null, 'x')).toEqual(services);
    expect(withSavedServiceOption(undefined, '', null)).toEqual([]);
  });
});

// QA6 P4 (PR-063): the Required qualifications save errors.
describe('qualificationSaveError', () => {
  it('words the two 400 codes; anything else uses the generic error', () => {
    expect(qualificationSaveError('PROFESSION_NOT_FOUND')?.title).toBe('A qualification no longer exists');
    expect(qualificationSaveError('PROFESSION_IDS_INVALID')?.title).toBe('The qualification list is not valid');
    expect(qualificationSaveError('BAD_REQUEST')).toBeNull();
    expect(qualificationSaveError(null)).toBeNull();
    for (const code of ['PROFESSION_NOT_FOUND', 'PROFESSION_IDS_INVALID']) {
      expect(Object.values(qualificationSaveError(code)!).join(' ')).not.toMatch(/[–—]/);
    }
  });
});
