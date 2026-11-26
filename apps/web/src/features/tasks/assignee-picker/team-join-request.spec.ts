import { describe, expect, it } from 'vitest';

import {
  readTeamJoinRequestResult,
  readTeamRequestedAt,
  selfAssignMode,
  TEAM_REQUEST_TEXT,
  teamRequestFailure,
  teamRequestState,
} from './team-join-request';

/** QA6 decision 2 (26.11) — no self-assign for a viewer who is not on the Team. */

describe('selfAssignMode', () => {
  it('a personal task (no project) has no Team: he assigns himself', () => {
    expect(selfAssignMode({ projectId: null, project: undefined })).toBe('self');
    expect(selfAssignMode({ projectId: undefined, project: { isOnTeam: false, canManage: false } })).toBe('self');
  });

  it('on the Team, or a leader / Admin (the server adds a manager as participant): self-assign', () => {
    expect(selfAssignMode({ projectId: 58, project: { isOnTeam: true, canManage: false } })).toBe('self');
    expect(selfAssignMode({ projectId: 58, project: { isOnTeam: false, canManage: true } })).toBe('self');
  });

  it('not on the Team and cannot manage (org unit / manager chain only): ask the project manager', () => {
    expect(selfAssignMode({ projectId: 58, project: { isOnTeam: false, canManage: false } })).toBe('request');
    expect(selfAssignMode({ projectId: 58, project: { isOnTeam: false } })).toBe('request');
  });

  it('while the project read is loading, or from a server without isOnTeam: neither', () => {
    expect(selfAssignMode({ projectId: 58, project: undefined })).toBe('unknown');
    expect(selfAssignMode({ projectId: 58, project: { canManage: false } })).toBe('unknown');
    expect(selfAssignMode({ projectId: 58, project: { isOnTeam: null, canManage: false } })).toBe('unknown');
  });
});

describe('readTeamJoinRequestResult', () => {
  it('reads the { success, data } envelope and the bare body', () => {
    expect(readTeamJoinRequestResult({ success: true, data: { alreadyRequested: false, requestedAt: '2026-11-26T08:00:00.000Z' } })).toEqual({
      alreadyRequested: false,
      requestedAt: '2026-11-26T08:00:00.000Z',
    });
    expect(readTeamJoinRequestResult({ alreadyRequested: true, requestedAt: '2026-11-25T09:00:00.000Z' })).toEqual({
      alreadyRequested: true,
      requestedAt: '2026-11-25T09:00:00.000Z',
    });
  });

  it('anything else reads as a plain, undated request', () => {
    expect(readTeamJoinRequestResult(null)).toEqual({ alreadyRequested: false, requestedAt: null });
    expect(readTeamJoinRequestResult({ data: null })).toEqual({ alreadyRequested: false, requestedAt: null });
  });
});

describe('teamRequestState', () => {
  it('idle → sending → sent; a request in the last 24 hours (alreadyRequested) is sent too', () => {
    expect(teamRequestState({ pending: false, sentAt: null })).toBe('idle');
    expect(teamRequestState({ pending: true, sentAt: undefined })).toBe('sending');
    expect(teamRequestState({ pending: false, sentAt: '2026-11-26T08:00:00.000Z' })).toBe('sent');
    expect(teamRequestState({ pending: true, sentAt: '2026-11-26T08:00:00.000Z' })).toBe('sent');
  });

  it('after a reload: teamRequestedAt from GET /projects/:id opens the button as sent', () => {
    expect(teamRequestState({ pending: false, sentAt: undefined, serverRequestedAt: '2026-11-25T09:00:00.000Z' })).toBe('sent');
    expect(teamRequestState({ pending: false, sentAt: undefined, serverRequestedAt: null })).toBe('idle');
  });
});

describe('readTeamRequestedAt', () => {
  it('his own request of the last 24 hours, else null (also for a server without the field)', () => {
    expect(readTeamRequestedAt({ teamRequestedAt: '2026-11-25T09:00:00.000Z' })).toBe('2026-11-25T09:00:00.000Z');
    expect(readTeamRequestedAt({ teamRequestedAt: null })).toBeNull();
    expect(readTeamRequestedAt({})).toBeNull();
    expect(readTeamRequestedAt(undefined)).toBeNull();
    expect(readTeamRequestedAt({ teamRequestedAt: 42 })).toBeNull();
  });
});

describe('teamRequestFailure', () => {
  it('409 ALREADY_ON_TEAM / CAN_MANAGE_PROJECT = the screen is out of date; anything else is an error', () => {
    expect(teamRequestFailure('ALREADY_ON_TEAM')).toBe('stale');
    expect(teamRequestFailure('CAN_MANAGE_PROJECT')).toBe('stale');
    expect(teamRequestFailure('PERMISSION_DENIED')).toBe('error');
    expect(teamRequestFailure(null)).toBe('error');
  });
});

describe('TEAM_REQUEST_TEXT', () => {
  it('uses the decision\'s wording, with no long dashes', () => {
    expect(TEAM_REQUEST_TEXT.button).toBe('בקש ממנהל הפרויקט להוסיף אותך');
    expect(TEAM_REQUEST_TEXT.sent).toBe('הבקשה נשלחה למנהל הפרויקט');
    for (const text of Object.values(TEAM_REQUEST_TEXT)) expect(text).not.toMatch(/[–—]/);
  });
});
