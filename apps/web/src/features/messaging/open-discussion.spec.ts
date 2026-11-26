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
});
