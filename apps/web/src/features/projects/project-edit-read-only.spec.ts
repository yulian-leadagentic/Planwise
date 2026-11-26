/**
 * QA6 round 3 (26.11) · /projects/:id/edit for someone who can open the
 * project but cannot manage it (not the leader, not an Admin). He used
 * to get the full form and a 403 NOT_PROJECT_LEADER on Save. Now he gets
 * a read-only notice with a link back to the project; the leader and an
 * Admin keep the form. The decision is `projectManageActions(...).edit`,
 * the same one that hides the header's Edit pencil.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  error: null as unknown,
  isAdmin: false,
}));

vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: state.project ?? undefined, isLoading: false, error: state.error }),
  useCreateProject: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProject: () => ({ mutate: vi.fn(), isPending: false }),
  useProjectTypes: () => ({ data: [] }),
}));

// projects:write and every other module grant: only `canManage` decides.
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isAdmin: state.isAdmin, user: { id: 70 } }),
}));

import { ProjectFormPage } from './project-form-page';
import { ProjectEditReadOnly, PROJECT_EDIT_READ_ONLY_MESSAGE } from './project-edit-read-only';

const PROJECT = { id: 59, name: 'Tower B', number: 'PRJ-059', projectTypeId: 1, status: 'active', startDate: null, endDate: null };

function renderEditPage() {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/projects/59/edit'] },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Routes, null, createElement(Route, { path: '/projects/:id/edit', element: createElement(ProjectFormPage) })),
      ),
    ),
  );
}

describe('ProjectEditReadOnly', () => {
  it('says who can edit and links back to the project', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ProjectEditReadOnly, { projectId: 59, projectName: 'Tower B' })),
    );
    expect(PROJECT_EDIT_READ_ONLY_MESSAGE).toBe('Only the project leader or an administrator can edit this project.');
    expect(html).toContain(PROJECT_EDIT_READ_ONLY_MESSAGE);
    expect(html).toContain('Tower B');
    expect(html).toContain('href="/projects/59"');
    expect(html).toContain('Back to project');
    expect(html).not.toContain('<input');
    expect(html).not.toMatch(/[—–]/);
  });
});

describe('/projects/:id/edit · who gets the form', () => {
  beforeEach(() => {
    state.project = null;
    state.error = null;
    state.isAdmin = false;
  });

  it('a non-manager (canManage false, even with projects:write) gets the notice, not the form', () => {
    state.project = { ...PROJECT, canManage: false };
    const html = renderEditPage();
    expect(html).toContain(PROJECT_EDIT_READ_ONLY_MESSAGE);
    expect(html).toContain('href="/projects/59"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Update Project');
  });

  it('an older payload without canManage fails closed: the notice', () => {
    state.project = { ...PROJECT };
    const html = renderEditPage();
    expect(html).toContain(PROJECT_EDIT_READ_ONLY_MESSAGE);
    expect(html).not.toContain('<form');
  });

  it('the leader (canManage true) gets the form', () => {
    state.project = { ...PROJECT, canManage: true };
    const html = renderEditPage();
    expect(html).toContain('<form');
    expect(html).toContain('Update Project');
    expect(html).not.toContain(PROJECT_EDIT_READ_ONLY_MESSAGE);
  });

  it('an Admin (canManage true) gets the form', () => {
    state.isAdmin = true;
    state.project = { ...PROJECT, canManage: true };
    expect(renderEditPage()).toContain('Update Project');
  });

  it('a project he cannot open (403) shows the No-access card, not the form', () => {
    state.error = {
      message: 'Request failed with status code 403',
      response: { status: 403, data: { success: false, error: { code: 'PERMISSION_DENIED', details: { reason: 'NOT_PROJECT_MEMBER' } } } },
    };
    const html = renderEditPage();
    expect(html).toContain('No access');
    expect(html).not.toContain('<form');
  });
});
