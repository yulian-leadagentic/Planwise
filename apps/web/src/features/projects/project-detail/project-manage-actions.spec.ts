/**
 * QA6 round 2 (26.11) · finding 3: a Professional who sees a project
 * through its org unit (not the leader, not Admin) saw "Close project"
 * and "Delete" as live buttons. Managing a project is leader or Admin
 * only (`canManage` from GET /projects/:id); delete also needs
 * projects:delete. Others get no control at all.
 *
 * QA6 round 3: the same answer drives the Project Info tab fields
 * (`editInfo`) and the Team tab's roles (`editTeam`, partners:write).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { canManageProject, projectManageActions } from './project-manage-actions';
import { ProjectStatusEditor } from './project-status-editor';
import { ProjectCategoryEditor } from './project-category-editor';

type Perm = 'write' | 'delete' | 'partners:write';
const perms = (isAdmin: boolean, granted: Perm[]) => ({
  isAdmin,
  can: (module: string, action: 'write' | 'delete') =>
    module === 'projects'
      ? granted.includes(action)
      : module === 'partners' && action === 'write' && granted.includes('partners:write'),
});

const NONE = { edit: false, changeStatus: false, changeCategories: false, closeOrReopen: false, delete: false, editInfo: false, editTeam: false };
const ALL = { edit: true, changeStatus: true, changeCategories: true, closeOrReopen: true, delete: true, editInfo: true, editTeam: true };
const EVERY_GRANT: Perm[] = ['write', 'delete', 'partners:write'];

describe('projectManageActions · the project page manage actions', () => {
  it('a viewer with project access only (org unit, canManage false) gets none, even with every module grant', () => {
    expect(projectManageActions({ canManage: false }, perms(false, EVERY_GRANT))).toEqual(NONE);
  });

  it('the leader with projects:write + delete + partners:write gets all of them', () => {
    expect(projectManageActions({ canManage: true }, perms(false, EVERY_GRANT))).toEqual(ALL);
  });

  it('the leader without projects:delete gets everything but Delete', () => {
    expect(projectManageActions({ canManage: true }, perms(false, ['write', 'partners:write']))).toEqual({ ...ALL, delete: false });
  });

  it('the leader without projects:write cannot edit, close or delete through write routes, but delete follows projects:delete', () => {
    expect(projectManageActions({ canManage: true }, perms(false, ['delete']))).toEqual({ ...NONE, delete: true });
  });

  it('the leader without partners:write keeps the project settings but not the Team roles', () => {
    expect(projectManageActions({ canManage: true }, perms(false, ['write', 'delete']))).toEqual({ ...ALL, editTeam: false });
  });

  it('an Admin (canManage true) gets all of them: the API bypasses module permissions for Admin', () => {
    expect(projectManageActions({ canManage: true }, perms(true, []))).toEqual(ALL);
  });

  it('no canManage in the payload (older API), or no project: none (fail closed)', () => {
    expect(projectManageActions({}, perms(true, EVERY_GRANT))).toEqual(NONE);
    expect(projectManageActions(null, perms(false, EVERY_GRANT))).toEqual(NONE);
    expect(projectManageActions({ canManage: 'true' }, perms(false, EVERY_GRANT))).toEqual(NONE);
  });

  it('canManageProject is the one leader-or-Admin answer: only `true` counts', () => {
    expect(canManageProject({ canManage: true })).toBe(true);
    for (const p of [{ canManage: false }, { canManage: 'true' }, { canManage: 1 }, {}, null, undefined]) {
      expect(canManageProject(p)).toBe(false);
    }
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
