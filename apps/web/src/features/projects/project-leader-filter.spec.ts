import { describe, expect, it } from 'vitest';
import {
  NO_TEAM_LEADER_KEY,
  NO_TEAM_LEADER_LABEL,
  matchesTeamLeaderFilter,
  projectTeamLeaders,
  teamLeaderFilterOptions,
  userIdFromLeaderKey,
} from './project-leader-filter';

const TL = 7; // team_leader role-type id
const OTHER_ROLE = 9;

const dana = { id: 11, firstName: 'Dana', lastName: 'Levi' };
const amit = { id: 12, firstName: 'Amit', lastName: 'Maimoni' };

const roleRow = (roleId: number, partyId: number, displayName: string, userId?: number) => ({
  roleId,
  party: { id: partyId, displayName, user: userId != null ? { id: userId } : null },
});

// Legacy leader only.
const pLegacy = { id: 1, leader: dana, partnerRoles: [] };
// Legacy leader + the same person on the team_leader role (dedupe).
const pBoth = { id: 2, leader: dana, partnerRoles: [roleRow(TL, 501, 'Dana Levi', 11)] };
// Two team leaders via the role, no legacy leader.
const pTwoRole = {
  id: 3,
  leader: null,
  partnerRoles: [roleRow(TL, 502, 'Amit Maimoni', 12), roleRow(TL, 503, 'Outside Lead')],
};
// No leader at all; another role must not count as a leader.
const pNone = { id: 4, leader: null, partnerRoles: [roleRow(OTHER_ROLE, 504, 'Some BIM Lead', 13)] };

describe('projectTeamLeaders (PR-066)', () => {
  it('reads the legacy leader', () => {
    expect(projectTeamLeaders(pLegacy, TL)).toEqual([{ key: 'u:11', label: 'Dana Levi' }]);
  });

  it('dedupes the legacy leader and the team_leader role by user id', () => {
    expect(projectTeamLeaders(pBoth, TL)).toEqual([{ key: 'u:11', label: 'Dana Levi' }]);
  });

  it('reads every team_leader role holder, by user id or party id', () => {
    expect(projectTeamLeaders(pTwoRole, TL)).toEqual([
      { key: 'u:12', label: 'Amit Maimoni' },
      { key: 'p:503', label: 'Outside Lead' },
    ]);
  });

  it('ignores other roles, and role rows when the team_leader type is unknown', () => {
    expect(projectTeamLeaders(pNone, TL)).toEqual([]);
    expect(projectTeamLeaders(pTwoRole, null)).toEqual([]);
  });
});

describe('matchesTeamLeaderFilter (PR-066)', () => {
  const all = [pLegacy, pBoth, pTwoRole, pNone];
  const pick = (keys: string[]) => all.filter((p) => matchesTeamLeaderFilter(p, keys, TL)).map((p) => p.id);

  it('lets everything through with an empty selection', () => {
    expect(pick([])).toEqual([1, 2, 3, 4]);
  });

  it('matches a single leader on either source', () => {
    expect(pick(['u:11'])).toEqual([1, 2]);
    expect(pick(['u:12'])).toEqual([3]);
    expect(pick(['p:503'])).toEqual([3]);
  });

  it('is a union across selected leaders', () => {
    expect(pick(['u:11', 'u:12'])).toEqual([1, 2, 3]);
  });

  it('supports the "No team leader" bucket alone and combined', () => {
    expect(pick([NO_TEAM_LEADER_KEY])).toEqual([4]);
    expect(pick([NO_TEAM_LEADER_KEY, 'u:12'])).toEqual([3, 4]);
  });

  it('matches nothing for a leader not on any project', () => {
    expect(pick(['u:999'])).toEqual([]);
  });
});

describe('teamLeaderFilterOptions (PR-066)', () => {
  it('lists distinct leaders by name, then the "No team leader" bucket', () => {
    expect(teamLeaderFilterOptions([pLegacy, pBoth, pTwoRole, pNone], TL)).toEqual([
      { key: 'u:12', label: 'Amit Maimoni' },
      { key: 'u:11', label: 'Dana Levi' },
      { key: 'p:503', label: 'Outside Lead' },
      { key: NO_TEAM_LEADER_KEY, label: NO_TEAM_LEADER_LABEL },
    ]);
  });

  it('omits the bucket when every project has a leader', () => {
    expect(teamLeaderFilterOptions([pLegacy], TL)).toEqual([{ key: 'u:11', label: 'Dana Levi' }]);
  });

  it('keeps persisted selections that are not on screen so they can be cleared', () => {
    const opts = teamLeaderFilterOptions([pLegacy], TL, ['u:12', 'p:777', NO_TEAM_LEADER_KEY], (key) =>
      key === 'u:12' ? 'Amit Maimoni' : null,
    );
    expect(opts).toEqual([
      { key: 'u:12', label: 'Amit Maimoni' },
      { key: 'u:11', label: 'Dana Levi' },
      { key: 'p:777', label: 'Unknown leader' },
      { key: NO_TEAM_LEADER_KEY, label: NO_TEAM_LEADER_LABEL },
    ]);
  });
});

describe('userIdFromLeaderKey', () => {
  it('parses user keys only', () => {
    expect(userIdFromLeaderKey('u:42')).toBe(42);
    expect(userIdFromLeaderKey('p:42')).toBeNull();
    expect(userIdFromLeaderKey(NO_TEAM_LEADER_KEY)).toBeNull();
  });
});
