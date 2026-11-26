/**
 * Round 4C-2 (2026-11-23) — Inbox and bell clicks: an item the user
 * can't open as a page (seen only through a mention) opens the
 * discussion drawer; everything else navigates as before.
 */
import { describe, it, expect } from 'vitest';
import { inboxItemAction, notificationClickAction } from './open-discussion';

describe('Inbox item click', () => {
  it('a thread he can see only through a mention opens the discussion drawer', () => {
    expect(inboxItemAction({ entityType: 'project', entityId: 10, canOpenEntity: false })).toEqual({
      kind: 'drawer',
      target: { entityType: 'project', entityId: 10 },
    });
    expect(inboxItemAction({ entityType: 'task', entityId: 500, canOpenEntity: false })).toEqual({
      kind: 'drawer',
      target: { entityType: 'task', entityId: 500 },
    });
  });

  it('an accessible item navigates as before', () => {
    expect(inboxItemAction({ entityType: 'project', entityId: 10, canOpenEntity: true })).toEqual({
      kind: 'navigate',
      to: '/projects/10',
    });
    expect(inboxItemAction({ entityType: 'task', entityId: 500, canOpenEntity: true })).toEqual({
      kind: 'navigate',
      to: '/projects',
    });
  });

  it('an older payload without the flag navigates', () => {
    expect(inboxItemAction({ entityType: 'project', entityId: 10 })).toEqual({ kind: 'navigate', to: '/projects/10' });
  });
});

describe('Bell notification click', () => {
  it('a mention in a project he can\'t open opens the discussion drawer', () => {
    expect(
      notificationClickAction({ entityType: 'project', entityId: 10, messageId: 100, canOpenEntity: false }),
    ).toEqual({ kind: 'drawer', target: { entityType: 'project', entityId: 10 } });
  });

  it('an accessible mention, or a non-message notification, navigates as before', () => {
    expect(notificationClickAction({ entityType: 'project', entityId: 10, messageId: 100, canOpenEntity: true })).toEqual({
      kind: 'navigate',
      to: '/projects/10',
    });
    expect(notificationClickAction({ entityType: 'project', entityId: 10, canOpenEntity: false })).toEqual({
      kind: 'navigate',
      to: '/projects/10',
    });
    expect(notificationClickAction({})).toEqual({ kind: 'navigate', to: '/inbox' });
  });

  it('QA6 — a notification with an in-app link (a "join the team" request) opens that link', () => {
    expect(
      notificationClickAction({ entityType: 'project', entityId: 58, canOpenEntity: true, link: '/projects/58?projectTab=team' }),
    ).toEqual({ kind: 'navigate', to: '/projects/58?projectTab=team' });
    // A mention he can open only as a thread still goes to the drawer.
    expect(
      notificationClickAction({ entityType: 'project', entityId: 10, messageId: 1, canOpenEntity: false, link: '/projects/10' }),
    ).toEqual({ kind: 'drawer', target: { entityType: 'project', entityId: 10 } });
  });

  // QA6 P4 (PR-063): task-move notifications open Operations › Workload on the right week.
  it('a reassign request opens the Workload tab on the week of the move, with the approvals', () => {
    expect(
      notificationClickAction({ type: 'reassign_request', entityType: 'task_reassignment', entityId: 881, data: { taskId: 4021, projectId: 59, toDay: '2026-11-24' } }),
    ).toEqual({ kind: 'navigate', to: '/operations?tab=workload&weekOf=2026-11-24&approvals=1' });
  });

  it('a reassign result (or the moved-away notice) opens the week too; no usable day: this week', () => {
    expect(notificationClickAction({ type: 'reassign_result', entityType: 'task_reassignment', entityId: 881, data: { toDay: '2026-12-01' } })).toEqual({
      kind: 'navigate',
      to: '/operations?tab=workload&weekOf=2026-12-01',
    });
    expect(notificationClickAction({ type: 'reassign_moved', entityType: 'task', entityId: 4021, data: { fromDay: '2026-11-23' } })).toEqual({
      kind: 'navigate',
      to: '/operations?tab=workload&weekOf=2026-11-23',
    });
    expect(notificationClickAction({ type: 'reassign_result', data: { toDay: 'soon' } })).toEqual({ kind: 'navigate', to: '/operations?tab=workload' });
    expect(notificationClickAction({ type: 'system', entityType: 'task_reassignment', entityId: 1 })).toEqual({ kind: 'navigate', to: '/operations?tab=workload' });
  });
});
