import { describe, expect, it } from 'vitest';
import {
  deleteBlockedReason,
  isTemplateArchived,
  isTemplateInUse,
  templateListQueryKey,
  templateListUrl,
  templateUsageText,
} from './template-archive';

describe('PR-053 · template list views', () => {
  it('the Active view is the picker list (same URL and query key)', () => {
    expect(templateListUrl('task_list', 'active')).toBe('/templates?type=task_list');
    expect(templateListQueryKey('task_list', 'active')).toEqual(['templates', 'task_list']);
    expect(templateListUrl('zone', 'active')).toBe('/templates?type=zone');
    expect(templateListQueryKey('zone', 'active')).toEqual(['templates', 'zone']);
  });

  it('the Archived view asks the server for archived templates only', () => {
    expect(templateListUrl('task_list', 'archived')).toBe('/templates?type=task_list&archived=only');
    expect(templateListUrl('zone', 'archived')).toBe('/templates?type=zone&archived=only');
    // Under the active key, so invalidating ['templates', type] refreshes it too.
    expect(templateListQueryKey('zone', 'archived')).toEqual(['templates', 'zone', 'archived']);
  });
});

describe('PR-053 · in use / delete rule', () => {
  const unused = { usageCount: 0, usage: { applied: 0, projectDeliverables: 0, projectTasks: 0, composingTemplates: 0, inUse: false } };
  const used = {
    usageCount: 2,
    usage: { applied: 2, projectDeliverables: 1, projectTasks: 0, composingTemplates: 1, inUse: true },
  };

  it('reads "in use" from the server usage, falling back to usageCount', () => {
    expect(isTemplateInUse(unused)).toBe(false);
    expect(isTemplateInUse(used)).toBe(true);
    expect(isTemplateInUse({ usageCount: 3 })).toBe(true);
    expect(isTemplateInUse({ usageCount: 0 })).toBe(false);
    // Referenced by another template but never applied: still in use.
    expect(
      isTemplateInUse({
        usageCount: 0,
        usage: { applied: 0, projectDeliverables: 0, projectTasks: 0, composingTemplates: 1, inUse: true },
      }),
    ).toBe(true);
  });

  it('delete is open only for an unused template, with the reason otherwise', () => {
    expect(deleteBlockedReason(unused)).toBeNull();
    const reason = deleteBlockedReason(used)!;
    expect(reason).toBe(
      'In use (applied 2 times, 1 project deliverable, used by 1 other template). Archive it instead of deleting it.',
    );
    expect(reason).not.toMatch(/[–—]/);
  });

  it('usage text lists only the non-zero parts', () => {
    expect(templateUsageText(unused)).toBe('');
    expect(
      templateUsageText({
        usage: { applied: 0, projectDeliverables: 0, projectTasks: 5, composingTemplates: 0, inUse: true },
      }),
    ).toBe('5 project tasks');
  });

  it('archived = archivedAt set', () => {
    expect(isTemplateArchived({ archivedAt: '2026-11-25T08:00:00.000Z' })).toBe(true);
    expect(isTemplateArchived({ archivedAt: null })).toBe(false);
    expect(isTemplateArchived({})).toBe(false);
  });
});
