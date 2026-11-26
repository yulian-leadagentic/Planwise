/**
 * QA6 round 2 (26.11) · finding 3: a Professional who sees a project
 * through its org unit (not the leader, not Admin) saw "Close project"
 * and "Delete" as live buttons. Managing a project is leader or Admin
 * only (`canManage` from GET /projects/:id); delete also needs
 * projects:delete. Others get no control at all.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { projectManageActions } from './project-manage-actions';
import { ProjectStatusEditor } from './project-status-editor';
import { ProjectCategoryEditor } from './project-category-editor';

type Perm = 'write' | 'delete';
const perms = (isAdmin: boolean, granted: Perm[]) => ({ isAdmin, can: (module: string, action: Perm) => module === 'projects' && granted.includes(action) });

const NONE = { edit: false, changeStatus: false, changeCategories: false, closeOrReopen: false, delete: false };
const ALL = { edit: true, changeStatus: true, changeCategories: true, closeOrReopen: true, delete: true };

describe('projectManageActions · the project header manage actions', () => {
  it('a viewer with project access only (org unit, canManage false) gets none, even with projects:write + delete', () => {
    expect(projectManageActions({ canManage: false }, perms(false, ['write', 'delete']))).toEqual(NONE);
  });

  it('the leader with projects:write + delete gets all of them', () => {
    expect(projectManageActions({ canManage: true }, perms(false, ['write', 'delete']))).toEqual(ALL);
  });

  it('the leader without projects:delete gets everything but Delete', () => {
    expect(projectManageActions({ canManage: true }, perms(false, ['write']))).toEqual({ ...ALL, delete: false });
  });

  it('the leader without projects:write cannot edit, close or delete through write routes, but delete follows projects:delete', () => {
    expect(projectManageActions({ canManage: true }, perms(false, ['delete']))).toEqual({ ...NONE, delete: true });
  });

  it('an Admin (canManage true) gets all of them: the API bypasses module permissions for Admin', () => {
    expect(projectManageActions({ canManage: true }, perms(true, []))).toEqual(ALL);
  });

  it('no canManage in the payload (older API), or no project: none (fail closed)', () => {
    expect(projectManageActions({}, perms(true, ['write', 'delete']))).toEqual(NONE);
    expect(projectManageActions(null, perms(false, ['write', 'delete']))).toEqual(NONE);
    expect(projectManageActions({ canManage: 'true' }, perms(false, ['write', 'delete']))).toEqual(NONE);
  });
});

describe('Header editors · read-only without the manage right', () => {
  const wrap = (el: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));

  it('the status pill is plain text (no menu button) when canEdit is false', () => {
    const html = wrap(createElement(ProjectStatusEditor, { projectId: 59, status: 'active', canEdit: false }));
    expect(html).toContain('Active');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Change status');
  });

  it('the status pill opens a menu when canEdit is true', () => {
    const html = wrap(createElement(ProjectStatusEditor, { projectId: 59, status: 'active', canEdit: true }));
    expect(html).toContain('Change status');
  });

  it('the category chips are read-only when canEdit is false', () => {
    const projectType = { id: 1, name: 'Residential', color: '#2563EB' };
    const html = wrap(createElement(ProjectCategoryEditor, { projectId: 59, projectType, canEdit: false }));
    expect(html).toContain('Residential');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Change categories');
  });
});
