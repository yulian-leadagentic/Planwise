/**
 * QA6 round 2 (26.11) · which manage actions the project page offers.
 *
 * Round 4 rule: managing a project (edit / settings, status, categories,
 * close / reopen, delete, the team and its roles) is leader or Admin
 * only. GET /projects/:id returns that answer as `canManage` (the
 * server's assertProjectManage). The routes also need the module
 * permission: projects:write (partners:write for the team's roles), and
 * projects:delete for delete. An Admin passes those (RolesGuard bypass),
 * so the web mirrors that.
 *
 * Everyone else gets no control at all: hidden or read-only text, not
 * disabled. A payload without `canManage` (an older API) offers none;
 * the API would refuse.
 *
 * One source for the header, the Project Info tab, the Team tab and the
 * edit page, so they cannot disagree.
 */
export type ProjectManageActions = {
  /** The pencil to /projects/:id/edit, and the edit page itself (settings, leader, org unit, customer). */
  edit: boolean;
  /** The status pill opens a menu (else a read-only pill). */
  changeStatus: boolean;
  /** The category chips open a menu (else read-only chips). */
  changeCategories: boolean;
  /** "Close project" / "Re-open". */
  closeOrReopen: boolean;
  /** "Delete". */
  delete: boolean;
  /**
   * Project Info tab fields (Weekly Meeting Day, Authoring Tool Version,
   * Services Per Contract): inputs, else read-only text. PATCH /projects/:id.
   */
  editInfo: boolean;
  /**
   * Team tab: "Add person", the Project Role cell (leader, BIM Leader, ...),
   * the "not assigned +" coverage chips and "Remove from project".
   * POST / DELETE /project-partner-roles (partners:write) and
   * /projects/:id/members.
   */
  editTeam: boolean;
};

/** Leader or Admin, as GET /projects/:id reports it. Anything but `true` is no. */
export function canManageProject(project: { canManage?: unknown } | null | undefined): boolean {
  return project?.canManage === true;
}

export function projectManageActions(
  project: { canManage?: unknown } | null | undefined,
  perms: { isAdmin: boolean; can: (module: string, action: 'write' | 'delete') => boolean },
): ProjectManageActions {
  const manage = canManageProject(project);
  const write = manage && (perms.isAdmin || perms.can('projects', 'write'));
  return {
    edit: write,
    changeStatus: write,
    changeCategories: write,
    closeOrReopen: write,
    delete: manage && (perms.isAdmin || perms.can('projects', 'delete')),
    editInfo: write,
    editTeam: manage && (perms.isAdmin || perms.can('partners', 'write')),
  };
}
