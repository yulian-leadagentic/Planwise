/**
 * QA6 round 3 (26.11) · the project page for someone who can open the
 * project but cannot manage it (not the leader, not an Admin). Saving
 * any of these got 403 NOT_PROJECT_LEADER; now there is nothing to save:
 *   • Project Info tab: Weekly Meeting Day, Authoring Tool Version and
 *     Services Per Contract are text, not inputs (`editInfo`);
 *   • Team tab: no "Add person", no Project Role editor (leader, BIM
 *     Leader, ...), no "not assigned +" chip, no "Remove from project"
 *     (`editTeam`).
 * The leader and an Admin keep today's controls.
 */
import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectInfoFields, PROJECT_INFO_READ_ONLY_HINT } from './project-info-tab';
import { TeamTab, UnassignedRoleChip } from './team-tab';
import { projectManageActions } from './project-manage-actions';
import type { ProjectRoleTypeRow, ProjectTeamData } from './types';

const PROJECT_ID = 59;

function render(el: ReactElement, client = new QueryClient()) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, el)),
  );
}

// What a Professional with projects:write + partners:write who sees the
// project through its org unit gets, and what the leader gets.
const grants = { isAdmin: false, can: () => true };
const VIEWER = projectManageActions({ canManage: false }, grants);
const LEADER = projectManageActions({ canManage: true }, grants);

describe('Project Info tab · the fields', () => {
  const project = {
    id: PROJECT_ID,
    weeklyMeetingDay: 'Tuesdays at 10:00',
    authoringToolVersion: '',
    servicesPerContract: 'BIM coordination\nClash reports',
  };

  it('a non-manager sees the values as text: no input, no textarea, no autosave hint', () => {
    const html = render(createElement(ProjectInfoFields, { projectId: PROJECT_ID, project, canEdit: VIEWER.editInfo }));
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Changes save automatically');
    expect(html).toContain('Weekly Meeting Day');
    expect(html).toContain('Tuesdays at 10:00');
    expect(html).toContain('Authoring Tool Version');
    expect(html).toContain('BIM coordination\nClash reports');
    // An unset value is a muted "Not set", never a dash.
    expect(html).toMatch(/<span class="text-slate-400[^"]*">Not set<\/span>/);
    expect(html).not.toMatch(/[—–]/);
    expect(html).toContain(PROJECT_INFO_READ_ONLY_HINT);
  });

  it('the leader or an Admin keeps the inputs that save on blur', () => {
    const html = render(createElement(ProjectInfoFields, { projectId: PROJECT_ID, project, canEdit: LEADER.editInfo }));
    expect(html.match(/<input/g)).toHaveLength(2);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('value="Tuesdays at 10:00"');
    expect(html).toContain('Changes save automatically when you leave a field.');
    expect(html).not.toContain(PROJECT_INFO_READ_ONLY_HINT);
    expect(html).not.toContain('Not set');
  });

  it('no project payload yet (or no canManage flag): read-only', () => {
    const html = render(createElement(ProjectInfoFields, {
      projectId: PROJECT_ID,
      project: undefined,
      canEdit: projectManageActions(undefined, grants).editInfo,
    }));
    expect(html).not.toContain('<input');
    expect(html.match(/Not set/g)).toHaveLength(3);
  });
});

// ─── Team tab ─────────────────────────────────────────────────────

const role = (id: number, code: string, name: string, isPrimaryRequired = false): ProjectRoleTypeRow => ({
  id,
  code,
  name,
  description: null,
  allowedPartnerKind: 'person',
  requiredPartnerRoleCode: null,
  requiredProfessionIds: null,
  isPrimaryRequired,
  sortOrder: id,
  isSystem: false,
});
const TEAM_LEADER = role(1, 'team_leader', 'Team Leader', true);
const BIM_LEADER = role(2, 'bim_leader', 'BIM Leader', true);

const TEAM: ProjectTeamData = {
  customer: null,
  customerContacts: [],
  customerRelated: [],
  projectTeam: [
    {
      relationshipId: 11,
      businessPartnerId: 100,
      userId: 12,
      displayName: 'Dana Levi',
      firstName: 'Dana',
      lastName: 'Levi',
      email: 'dana@example.com',
      phone: null,
      position: null,
      roleInContext: null,
    },
  ],
  roleAssignments: [
    {
      id: 5,
      role: TEAM_LEADER,
      party: {
        id: 100,
        partnerType: 'person',
        displayName: 'Dana Levi',
        firstName: 'Dana',
        lastName: 'Levi',
        email: 'dana@example.com',
        phone: null,
        user: { id: 12 },
      },
      isPrimary: true,
      titleInProject: null,
      validFrom: null,
      validTo: null,
      status: 'active',
    },
  ],
};

function renderTeam(actions: { editTeam: boolean }, canManage: boolean) {
  const client = new QueryClient();
  client.setQueryData(['project-team', PROJECT_ID], TEAM);
  client.setQueryData(['project-role-types'], [TEAM_LEADER, BIM_LEADER]);
  client.setQueryData(['admin', 'disciplines', 'picker'], []);
  return render(
    createElement(TeamTab, {
      projectId: PROJECT_ID,
      members: [],
      showAddMember: false,
      onToggleAddMember: () => {},
      canEditTeam: actions.editTeam,
      canManage,
    }),
    client,
  );
}

describe('Team tab · project roles and membership', () => {
  it('a non-manager sees the team and its roles as text, with no way to change them', () => {
    const html = renderTeam(VIEWER, false);
    expect(html).toContain('Dana Levi');
    expect(html).toContain('Team Leader');
    expect(html).not.toContain('Add person');
    expect(html).not.toContain('Import contacts');
    expect(html).not.toContain('Change role (click to reassign)');
    expect(html).not.toContain('Add project role');
    expect(html).not.toContain('Remove from project');
    // The unfilled required role is a status, not a button with "+".
    expect(html).toContain('BIM Leader');
    expect(html).toContain('· not assigned');
    expect(html).not.toContain('aria-label="Add BIM Leader"');
    // Hidden, not a greyed-out button.
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it('the leader keeps Add person, the role editor, the "+" chip and Remove', () => {
    const html = renderTeam(LEADER, true);
    expect(html).toContain('Add person');
    expect(html).toContain('Change role (click to reassign)');
    expect(html).toContain('aria-label="Add BIM Leader"');
    expect(html).toContain('Remove from project');
  });

  it('the read-only "not assigned" chip has no button and no "+"', () => {
    const html = renderToStaticMarkup(createElement(UnassignedRoleChip, { roleName: 'BIM Leader' }));
    expect(html).toContain('BIM Leader');
    expect(html).toContain('· not assigned');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('+');
  });
});
